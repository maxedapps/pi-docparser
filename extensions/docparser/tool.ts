import { truncateHead, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES } from "./constants.ts";
import {
  appendDoctorHint,
  getMissingHostDependencyMessage,
  isDependencySetupMessage,
} from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import { buildDocumentParsePlan } from "./request.ts";
import { DocumentParseSchema } from "./schema.ts";
import type {
  DocumentParseDetails,
  DocumentParseParams,
  DocumentOutputFormat,
  InputInspection,
  ScreenshotSelection,
} from "./types.ts";

let liteParseModulePromise: Promise<typeof import("@llamaindex/liteparse")> | undefined;

async function loadLiteParseModule(): Promise<typeof import("@llamaindex/liteparse")> {
  liteParseModulePromise ??= import("@llamaindex/liteparse");
  return liteParseModulePromise;
}

function buildFriendlyErrorMessage(
  error: unknown,
  stage: "parse" | "screenshot" = "parse",
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (stage === "parse") {
    if (isDependencySetupMessage(message)) {
      return appendDoctorHint(message);
    }

    return message || "Document parsing failed.";
  }

  return message.startsWith("Screenshot generation failed:")
    ? message
    : `Screenshot generation failed: ${message}`;
}

function buildPreview(output: string): { preview: string; truncated: boolean } {
  const truncation = truncateHead(output, {
    maxLines: PREVIEW_MAX_LINES,
    maxBytes: PREVIEW_MAX_BYTES,
  });

  return {
    preview: truncation.content.trim(),
    truncated: truncation.truncated,
  };
}

type ProgressEmitter = (text: string) => void;

async function renderScreenshots(options: {
  parser: {
    screenshot(
      filePath: string,
      pageNumbers?: number[],
      quiet?: boolean,
    ): Promise<Array<{ pageNum: number; imageBuffer: Buffer }>>;
  };
  screenshotSelection?: ScreenshotSelection;
  inspection: InputInspection;
  resolvedPath: string;
  outputDir: string;
  signal?: AbortSignal;
  emit: ProgressEmitter;
}): Promise<{
  screenshotCount: number;
  screenshotDir?: string;
  screenshotPathsPreview?: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const selection = options.screenshotSelection;

  if (!selection) {
    return { screenshotCount: 0, warnings };
  }

  if (options.signal?.aborted) {
    warnings.push(
      "Operation was aborted before screenshot rendering. Parsed output was still saved.",
    );
    return { screenshotCount: 0, warnings };
  }

  if (options.inspection.category !== "pdf") {
    warnings.push(
      "Screenshots were requested, but this extension currently generates screenshots only for PDF inputs. The document was parsed, but screenshots were skipped.",
    );
    return { screenshotCount: 0, warnings };
  }

  try {
    options.emit(`Rendering screenshots for ${selection.description}...`);
    const screenshots = await options.parser.screenshot(
      options.resolvedPath,
      selection.pageNumbers,
      true,
    );
    const screenshotDir = join(options.outputDir, "screenshots");
    await mkdir(screenshotDir, { recursive: true });

    const allScreenshotPaths: string[] = [];
    for (const screenshot of screenshots) {
      const screenshotPath = join(screenshotDir, `page_${screenshot.pageNum}.png`);
      await writeFile(screenshotPath, screenshot.imageBuffer);
      allScreenshotPaths.push(screenshotPath);
    }

    const screenshotCount = allScreenshotPaths.length;
    options.emit(
      `Saved ${screenshotCount} screenshot${screenshotCount === 1 ? "" : "s"} to ${screenshotDir}`,
    );

    return {
      screenshotCount,
      screenshotDir,
      screenshotPathsPreview: allScreenshotPaths.slice(0, 10),
      warnings,
    };
  } catch (error) {
    warnings.push(buildFriendlyErrorMessage(error, "screenshot"));
    return { screenshotCount: 0, warnings };
  }
}

function buildSummary(options: {
  sourcePath: string;
  resolvedPath: string;
  outputFormat: DocumentOutputFormat;
  outputPath: string;
  pageCount: number;
  screenshotCount: number;
  screenshotDir?: string;
  screenshotPathsPreview?: string[];
  warnings: string[];
  preview: string;
  truncated: boolean;
}): string {
  const lines = [
    `Parsed document: ${options.sourcePath}`,
    `Resolved path: ${options.resolvedPath}`,
    `Output format: ${options.outputFormat}`,
    `Pages parsed: ${options.pageCount}`,
    `Parsed output saved to: ${options.outputPath}`,
  ];

  if (options.screenshotDir) {
    lines.push(`Screenshots saved to: ${options.screenshotDir}`);
    lines.push(`Screenshot count: ${options.screenshotCount}`);

    if (options.screenshotPathsPreview?.length) {
      lines.push("Screenshot files:");
      for (const screenshotPath of options.screenshotPathsPreview) {
        lines.push(`- ${screenshotPath}`);
      }

      if (options.screenshotCount > options.screenshotPathsPreview.length) {
        lines.push(
          `- ...and ${options.screenshotCount - options.screenshotPathsPreview.length} more`,
        );
      }
    }
  }

  if (options.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of options.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (options.preview.length > 0) {
    lines.push("Preview:");
    lines.push(options.preview);

    if (options.truncated) {
      lines.push("");
      lines.push(
        `Preview truncated. Use read on ${options.outputPath} for the full parsed output.`,
      );
    }
  }

  return lines.join("\n");
}

export function registerDocumentParseTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_parse",
    label: "Document Parse",
    description:
      "Parse local documents with bundled LiteParse support. Supports PDF, DOCX, PPTX, XLSX, CSV, and common images. Returns parsed output saved to temp files plus metadata and optional PDF screenshots.",
    promptSnippet:
      "Parse local documents to text or JSON with OCR, bounding boxes, page ranges, and optional PDF screenshots. Full results are saved to temp files for follow-up inspection with read.",
    promptGuidelines: [
      "Use this tool instead of composing LiteParse CLI commands manually when the user wants local document parsing.",
      "After this tool returns output or screenshot paths, use read on those files when you need the full parsed content or to inspect generated screenshots.",
    ],
    parameters: DocumentParseSchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Document parsing was cancelled before it started." }],
          details: {},
        };
      }

      const emit: ProgressEmitter = (text) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: {},
        });
      const params = rawParams as DocumentParseParams;

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const plan = buildDocumentParsePlan(params);
        const warnings = [...plan.warnings];

        emit("Checking host dependencies...");
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) {
          throw new Error(missingHostDependencyMessage);
        }

        emit("Loading LiteParse...");
        const { LiteParse } = await loadLiteParseModule();
        const parser = new LiteParse(plan.parserConfig);
        const outputDir = await mkdtemp(join(tmpdir(), "pi-document-parse-"));

        emit(`Parsing document: ${input.sourcePath}`);
        const parseResult = await parser.parse(input.resolvedPath, true);
        const outputFormat = plan.parserConfig.outputFormat ?? "text";
        const outputText =
          outputFormat === "json"
            ? JSON.stringify(parseResult.json ?? { pages: [] }, null, 2)
            : parseResult.text;
        const outputPath = join(outputDir, outputFormat === "json" ? "parsed.json" : "parsed.txt");
        await writeFile(outputPath, outputText, "utf8");
        emit(`Saved parsed output to ${outputPath}`);

        const screenshotResult = await renderScreenshots({
          parser,
          screenshotSelection: plan.screenshotSelection,
          inspection: input.inspection,
          resolvedPath: input.resolvedPath,
          outputDir,
          signal,
          emit,
        });
        warnings.push(...screenshotResult.warnings);

        const { preview, truncated } = buildPreview(outputText);
        const content = buildSummary({
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          outputFormat,
          outputPath,
          pageCount: parseResult.pages.length,
          screenshotCount: screenshotResult.screenshotCount,
          screenshotDir: screenshotResult.screenshotDir,
          screenshotPathsPreview: screenshotResult.screenshotPathsPreview,
          warnings,
          preview,
          truncated,
        });

        const details: DocumentParseDetails = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          outputFormat,
          outputPath,
          outputDir,
          pageCount: parseResult.pages.length,
          screenshotCount: screenshotResult.screenshotCount,
          screenshotDir: screenshotResult.screenshotDir,
          screenshotPathsPreview: screenshotResult.screenshotPathsPreview,
          warnings: warnings.length > 0 ? warnings : undefined,
        };

        return {
          content: [{ type: "text", text: content }],
          details,
        };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
