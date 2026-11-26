import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES } from "./constants.ts";
import {
  appendDoctorHint,
  getMissingHostDependencyMessage,
  isDependencySetupMessage,
} from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import { formatNativeExecutionError, NativeExecutionError } from "./native-executor.ts";
import {
  buildDocumentParsePlan,
  getProvidedRemovedV1Options,
  getRemovedV1OptionsMessage,
} from "./liteparse-config.ts";
import { DocumentParseSchema } from "./schema.ts";
import type {
  DocumentParseDetails,
  DocumentParseParams,
  DocumentOutputFormat,
  NativeExecutor,
  ScreenshotSelection,
} from "./types.ts";

function buildFriendlyErrorMessage(
  error: unknown,
  stage: "parse" | "screenshot" = "parse",
): string {
  const message =
    error instanceof NativeExecutionError
      ? formatNativeExecutionError(error, "Document parsing failed.")
      : error instanceof Error
        ? error.message
        : String(error);

  if (isDependencySetupMessage(message)) return appendDoctorHint(message);
  if (stage === "screenshot") {
    return message.startsWith("Screenshot generation failed:")
      ? message
      : `Screenshot generation failed: ${message}`;
  }
  return message || "Document parsing failed.";
}

async function readPreview(outputPath: string): Promise<{ preview: string; truncated: boolean }> {
  const fileStats = await stat(outputPath);
  const handle = await open(outputPath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(PREVIEW_MAX_BYTES, fileStats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const truncation = truncateHead(text, {
      maxLines: PREVIEW_MAX_LINES,
      maxBytes: PREVIEW_MAX_BYTES,
    });
    return {
      preview: truncation.content.trim(),
      truncated: truncation.truncated || fileStats.size > bytesRead,
    };
  } finally {
    await handle.close();
  }
}

type ProgressEmitter = (text: string) => void;

async function renderScreenshots(options: {
  executor: NativeExecutor;
  screenshotSelection?: ScreenshotSelection;
  resolvedPath: string;
  outputDir: string;
  dpi: number;
  password?: string;
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
  if (!selection) return { screenshotCount: 0, warnings };
  if (options.signal?.aborted) {
    warnings.push(
      "Operation was aborted before screenshot rendering. Parsed output was still saved.",
    );
    return { screenshotCount: 0, warnings };
  }

  try {
    options.emit(`Rendering screenshots for ${selection.description}...`);
    const screenshotDir = join(options.outputDir, "screenshots");
    const result = await options.executor.execute(
      {
        operation: "screenshot",
        inputPath: options.resolvedPath,
        stagingDir: join(options.outputDir, `.screenshot-${randomUUID()}`),
        outputDir: screenshotDir,
        pages: selection.pageNumbers,
        dpi: options.dpi,
        password: options.password,
      },
      { signal: options.signal },
    );
    options.emit(
      `Saved ${result.screenshots.length} screenshot${result.screenshots.length === 1 ? "" : "s"} to ${result.screenshotDir}`,
    );
    return {
      screenshotCount: result.screenshots.length,
      screenshotDir: result.screenshotDir,
      screenshotPathsPreview: result.screenshots.map((item) => item.outputPath).slice(0, 4),
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
      for (const screenshotPath of options.screenshotPathsPreview)
        lines.push(`- ${screenshotPath}`);
    }
  }
  if (options.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of options.warnings) lines.push(`- ${warning}`);
  }
  if (options.preview.length > 0) {
    lines.push("Preview:", options.preview);
    if (options.truncated) {
      lines.push(
        "",
        `Preview truncated. Use read on ${options.outputPath} for the full parsed output.`,
      );
    }
  }
  return lines.join("\n");
}

export function registerDocumentParseTool(pi: ExtensionAPI, executor: NativeExecutor): void {
  pi.registerTool({
    name: "document_parse",
    label: "Document Parse",
    description:
      "Parse local documents with bundled LiteParse v2 (PDF, DOCX, PPTX, XLSX, CSV, images) to bounded text or projected JSON saved to temp files, plus metadata and optional screenshots.",
    promptSnippet:
      "Extract text or stable projected JSON from local documents with page ranges, OCR, passwords, and optional screenshots.",
    promptGuidelines: [
      "Use this tool instead of composing LiteParse CLI commands manually when the user wants local document parsing.",
      "After this tool returns output or screenshot paths, use read on those files when you need the full parsed content or to inspect generated screenshots.",
      "Do not use removed LiteParse v1 options preciseBoundingBox or preserveLayoutAlignmentAcrossPages. Use JSON bounding boxes, document_search, document_screenshot, or targetPages instead.",
    ],
    parameters: DocumentParseSchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text" as const, text: "Document parsing was cancelled before it started." },
          ],
          details: {},
        };
      }
      const emit: ProgressEmitter = (text) =>
        onUpdate?.({ content: [{ type: "text", text }], details: {} });
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) throw new Error(getRemovedV1OptionsMessage(removedOptions));
      const params = rawParams as DocumentParseParams;
      let outputDir: string | undefined;
      let parseCompleted = false;

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const plan = buildDocumentParsePlan(params);
        const warnings = [...plan.warnings];
        emit("Checking host dependencies...");
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) throw new Error(missingHostDependencyMessage);

        outputDir = await mkdtemp(join(tmpdir(), "pi-document-parse-"));
        const outputFormat = plan.parserConfig.outputFormat;
        const outputPath = join(outputDir, outputFormat === "json" ? "parsed.json" : "parsed.txt");
        emit(`Parsing document: ${input.sourcePath}`);
        const parseResult = await executor.execute(
          {
            operation: "parse",
            inputPath: input.resolvedPath,
            stagingDir: join(outputDir, `.parse-${randomUUID()}`),
            outputPath,
            config: plan.parserConfig,
          },
          { signal },
        );
        parseCompleted = true;
        emit(`Saved parsed output to ${outputPath}`);

        const screenshotResult = await renderScreenshots({
          executor,
          screenshotSelection: plan.screenshotSelection,
          resolvedPath: input.resolvedPath,
          outputDir,
          dpi: plan.parserConfig.dpi,
          password: plan.parserConfig.password,
          signal,
          emit,
        });
        warnings.push(...screenshotResult.warnings);
        const { preview, truncated } = await readPreview(outputPath);
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
        return { content: [{ type: "text" as const, text: content }], details };
      } catch (error) {
        if (outputDir && !parseCompleted)
          await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
