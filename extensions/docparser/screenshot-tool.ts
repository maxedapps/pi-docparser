import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Type, type Static } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_DPI,
  INLINE_PNG_MAX_BYTES,
  INLINE_PNG_TOTAL_MAX_BYTES,
  MAX_DPI,
  MAX_PAGE_SELECTION_BYTES,
  MAX_SCREENSHOT_PAGES,
  MIN_DPI,
} from "./constants.ts";
import {
  appendDoctorHint,
  getMissingHostDependencyMessage,
  isDependencySetupMessage,
} from "./deps.ts";
import { resolveDocumentTarget, resolveScreenshotSelection } from "./input.ts";
import { getProvidedRemovedV1Options, getRemovedV1OptionsMessage } from "./liteparse-config.ts";
import { formatNativeExecutionError, NativeExecutionError } from "./native-executor.ts";
import type {
  DocumentScreenshotDetails,
  NativeExecutor,
  NativeScreenshotMetadata,
} from "./types.ts";

export const DocumentScreenshotSchema = Type.Object({
  path: Type.String({ description: "Path to the document file to screenshot" }),
  pages: Type.Optional(
    Type.String({
      maxLength: MAX_PAGE_SELECTION_BYTES,
      description: `Page selection for screenshots, e.g. "1-3,8" (maximum ${MAX_SCREENSHOT_PAGES} pages; default: page 1).`,
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: MIN_DPI,
      maximum: MAX_DPI,
      description: `Rendering DPI for screenshots (default: ${DEFAULT_DPI})`,
    }),
  ),
  password: Type.Optional(Type.String({ description: "Password for encrypted documents" })),
});

type DocumentScreenshotParams = Static<typeof DocumentScreenshotSchema>;

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildFriendlyErrorMessage(error: unknown): string {
  const message =
    error instanceof NativeExecutionError
      ? formatNativeExecutionError(error, "Screenshot generation failed.")
      : error instanceof Error
        ? error.message
        : String(error);
  if (isDependencySetupMessage(message)) return appendDoctorHint(message);
  return message.startsWith("Screenshot generation failed:")
    ? message
    : `Screenshot generation failed: ${message}`;
}

async function inlineScreenshots(metadata: NativeScreenshotMetadata[]): Promise<{
  images: Array<{ type: "image"; data: string; mimeType: "image/png" }>;
  warnings: string[];
}> {
  const images: Array<{ type: "image"; data: string; mimeType: "image/png" }> = [];
  const warnings: string[] = [];
  let rawTotal = 0;
  for (const screenshot of metadata.slice(0, MAX_SCREENSHOT_PAGES)) {
    if (screenshot.bytes > INLINE_PNG_MAX_BYTES) {
      warnings.push(
        `Page ${screenshot.pageNum} was not inlined because ${screenshot.outputPath} exceeds the ${INLINE_PNG_MAX_BYTES}-byte inline limit.`,
      );
      continue;
    }
    if (rawTotal + screenshot.bytes > INLINE_PNG_TOTAL_MAX_BYTES) {
      warnings.push(
        `Page ${screenshot.pageNum} was not inlined because the ${INLINE_PNG_TOTAL_MAX_BYTES}-byte aggregate inline limit was reached. Saved file: ${screenshot.outputPath}`,
      );
      continue;
    }
    try {
      const handle = await open(screenshot.outputPath, "r");
      try {
        const fileStats = await handle.stat();
        if (
          !fileStats.isFile() ||
          fileStats.size !== screenshot.bytes ||
          fileStats.size > INLINE_PNG_MAX_BYTES
        ) {
          warnings.push(
            `Page ${screenshot.pageNum} was not inlined because its saved PNG size changed. Saved file: ${screenshot.outputPath}`,
          );
          continue;
        }
        if (rawTotal + fileStats.size > INLINE_PNG_TOTAL_MAX_BYTES) {
          warnings.push(
            `Page ${screenshot.pageNum} was not inlined because the aggregate inline limit was reached. Saved file: ${screenshot.outputPath}`,
          );
          continue;
        }
        const image = Buffer.alloc(fileStats.size);
        const { bytesRead } = await handle.read(image, 0, image.byteLength, 0);
        const finalStats = await handle.stat();
        if (bytesRead !== image.byteLength || finalStats.size !== fileStats.size) {
          warnings.push(
            `Page ${screenshot.pageNum} was not inlined because its saved PNG changed while reading. Saved file: ${screenshot.outputPath}`,
          );
          continue;
        }
        rawTotal += image.byteLength;
        images.push({ type: "image", mimeType: "image/png", data: image.toString("base64") });
      } finally {
        await handle.close();
      }
    } catch {
      warnings.push(
        `Page ${screenshot.pageNum} could not be inlined, but remains available at ${screenshot.outputPath}.`,
      );
    }
  }
  return { images, warnings };
}

export function registerDocumentScreenshotTool(pi: ExtensionAPI, executor: NativeExecutor): void {
  pi.registerTool({
    name: "document_screenshot",
    label: "Document Screenshot",
    description: "Render up to four local document pages as PNG image blocks plus saved PNG paths.",
    promptSnippet:
      "Render document pages as PNG images you can inspect directly; also saves PNGs to temp files.",
    promptGuidelines: [
      "Use document_screenshot when document_parse text is not enough to answer because visual layout, charts, signatures, or figures matter.",
      `Request at most ${MAX_SCREENSHOT_PAGES} explicit pages per call; use bounded repeated calls for more pages.`,
      "Use document_search first when looking for a known phrase, then screenshot only the relevant pages.",
    ],
    parameters: DocumentScreenshotSchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Document screenshot rendering was cancelled before it started.",
            },
          ],
          details: {},
        };
      }
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) throw new Error(getRemovedV1OptionsMessage(removedOptions));
      const params = rawParams as DocumentScreenshotParams;
      const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });
      let outputDir: string | undefined;

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) throw new Error(missingHostDependencyMessage);
        const selection = resolveScreenshotSelection(params.pages);
        outputDir = await mkdtemp(join(tmpdir(), "pi-document-screenshot-"));
        const screenshotDir = join(outputDir, "screenshots");
        emit(`Rendering screenshots for ${selection.description}...`);
        const result = await executor.execute(
          {
            operation: "screenshot",
            inputPath: input.resolvedPath,
            stagingDir: join(outputDir, `.screenshot-${randomUUID()}`),
            outputDir: screenshotDir,
            pages: selection.pageNumbers,
            dpi: params.dpi ?? DEFAULT_DPI,
            password: normalizeOptionalString(params.password),
          },
          { signal },
        );
        const inline = await inlineScreenshots(result.screenshots);
        const lines = [
          `Rendered document screenshots: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Screenshot count: ${result.screenshots.length}`,
          `Screenshots saved to: ${result.screenshotDir}`,
        ];
        if (result.screenshots.length > 0) {
          lines.push("Screenshot files:");
          for (const screenshot of result.screenshots.slice(0, MAX_SCREENSHOT_PAGES)) {
            lines.push(`- page ${screenshot.pageNum}: ${screenshot.outputPath}`);
          }
        }
        if (inline.warnings.length > 0) {
          lines.push("Warnings:");
          for (const warning of inline.warnings) lines.push(`- ${warning}`);
        }
        const details: DocumentScreenshotDetails = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          outputDir,
          screenshotDir: result.screenshotDir,
          screenshots: result.screenshots.slice(0, MAX_SCREENSHOT_PAGES),
          warnings: inline.warnings.length > 0 ? inline.warnings : undefined,
        };
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }, ...inline.images],
          details,
        };
      } catch (error) {
        if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
