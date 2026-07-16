import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES } from "./constants.ts";
import {
  appendDoctorHint,
  getMissingHostDependencyMessage,
  isDependencySetupMessage,
} from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import {
  buildDocumentParsePlan,
  getProvidedRemovedV1Options,
  getRemovedV1OptionsMessage,
} from "./liteparse-config.ts";
import { runNativeDocumentJob } from "./native-runner.ts";
import type { NativeParseResult, NativeScreenshotResult } from "./native-protocol.ts";
import { DocumentParseSchema } from "./schema.ts";
import type {
  DocumentParseDetails,
  DocumentParseParams,
  DocumentOutputFormat,
  LiteParseToolConfig,
  ScreenshotSelection,
} from "./types.ts";

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
  parserConfig: LiteParseToolConfig;
  screenshotSelection?: ScreenshotSelection;
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

  try {
    options.emit(`Rendering screenshots for ${selection.description}...`);
    const result = await runNativeDocumentJob<NativeScreenshotResult>(
      {
        operation: "screenshot",
        filePath: options.resolvedPath,
        parserConfig: options.parserConfig,
        pageNumbers: selection.pageNumbers,
        outputDir: options.outputDir,
      },
      { signal: options.signal },
    );
    const allScreenshotPaths = result.screenshots.map((screenshot) => screenshot.outputPath);
    const screenshotDir = result.screenshotDir;
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
      "Parse local documents with bundled LiteParse v2 support. Supports PDF, DOCX, PPTX, XLSX, CSV, and common images. Returns parsed text or JSON saved to temp files plus metadata and optional screenshots.",
    promptSnippet:
      "Parse local documents to text or JSON with OCR, bounding boxes, page ranges, password support, offline OCR data, and optional screenshots. Full results are saved to temp files for follow-up inspection with read.",
    promptGuidelines: [
      "Use this tool instead of composing LiteParse CLI commands manually when the user wants local document parsing.",
      "After this tool returns output or screenshot paths, use read on those files when you need the full parsed content or to inspect generated screenshots.",
      "Do not use removed LiteParse v1 options preciseBoundingBox or preserveLayoutAlignmentAcrossPages. Use JSON bounding boxes, document_search, document_screenshot, or targetPages instead.",
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
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) {
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      }

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

        const outputDir = await mkdtemp(join(tmpdir(), "pi-document-parse-"));

        emit(`Parsing document in isolated worker: ${input.sourcePath}`);
        const parseResult = await runNativeDocumentJob<NativeParseResult>(
          {
            operation: "parse",
            filePath: input.resolvedPath,
            parserConfig: plan.parserConfig,
            outputDir,
          },
          { signal },
        );
        const outputFormat = parseResult.outputFormat;
        const outputPath = parseResult.outputPath;
        const outputText = await readFile(outputPath, "utf8");
        emit(`Saved parsed output to ${outputPath}`);

        const screenshotResult = await renderScreenshots({
          parserConfig: plan.parserConfig,
          screenshotSelection: plan.screenshotSelection,
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
          pageCount: parseResult.pageCount,
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
          pageCount: parseResult.pageCount,
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
