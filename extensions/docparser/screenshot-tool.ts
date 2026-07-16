import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type, type Static } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_DPI } from "./constants.ts";
import { appendDoctorHint, getMissingHostDependencyMessage } from "./deps.ts";
import { resolveDocumentTarget, resolveScreenshotSelection } from "./input.ts";
import { getProvidedRemovedV1Options, getRemovedV1OptionsMessage } from "./liteparse-config.ts";
import { runNativeDocumentJob } from "./native-runner.ts";
import type { NativeScreenshotResult } from "./native-protocol.ts";

const DocumentScreenshotSchema = Type.Object({
  path: Type.String({
    description: "Path to the document file to screenshot",
  }),
  pages: Type.Optional(
    Type.String({
      description:
        'Optional page selection for screenshots, e.g. "1-3,8" or "all". Defaults to all pages.',
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: 72,
      description: "Rendering DPI for screenshots (default: 150)",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description: "Optional password for encrypted or password-protected documents",
    }),
  ),
});

type DocumentScreenshotParams = Static<typeof DocumentScreenshotSchema>;

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildFriendlyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("LibreOffice is not installed") ||
    message.includes("ImageMagick is not installed")
  ) {
    return appendDoctorHint(message);
  }

  return message.startsWith("Screenshot generation failed:")
    ? message
    : `Screenshot generation failed: ${message}`;
}

export function registerDocumentScreenshotTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_screenshot",
    label: "Document Screenshot",
    description:
      "Render local document pages as PNG screenshots with LiteParse v2 and return image blocks plus saved PNG file paths. Use when text extraction is insufficient for charts, diagrams, signatures, dense tables, or layout.",
    promptSnippet:
      "Render document pages as PNG images the model can inspect directly; also saves PNGs to temp files.",
    promptGuidelines: [
      "Use document_screenshot when document_parse text is not enough to answer because visual layout, charts, signatures, or figures matter.",
      "Keep pages small, such as one to four pages, unless the user explicitly asks for more.",
      "Use document_search first when looking for a known phrase, then screenshot only the relevant pages.",
    ],
    parameters: DocumentScreenshotSchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text: "Document screenshot rendering was cancelled before it started.",
            },
          ],
          details: {},
        };
      }

      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) {
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      }

      const params = rawParams as DocumentScreenshotParams;
      const emit = (text: string) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: {},
        });

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) {
          throw new Error(missingHostDependencyMessage);
        }

        const selection = params.pages ? resolveScreenshotSelection(params.pages) : undefined;
        const outputDir = await mkdtemp(join(tmpdir(), "pi-document-screenshot-"));
        emit(
          `Rendering screenshots in isolated worker for ${selection?.description ?? "all pages"}...`,
        );
        const screenshotResult = await runNativeDocumentJob<NativeScreenshotResult>(
          {
            operation: "screenshot",
            filePath: input.resolvedPath,
            parserConfig: {
              dpi: params.dpi ?? DEFAULT_DPI,
              password: normalizeOptionalString(params.password),
              quiet: true,
            },
            pageNumbers: selection?.pageNumbers,
            outputDir,
          },
          { signal },
        );
        const screenshotDir = screenshotResult.screenshotDir;
        const detailsScreenshots = screenshotResult.screenshots;
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];

        const lines = [
          `Rendered document screenshots: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Screenshot count: ${detailsScreenshots.length}`,
          `Screenshots saved to: ${screenshotDir}`,
        ];

        if (detailsScreenshots.length > 0) {
          lines.push("Screenshot files:");
          for (const screenshot of detailsScreenshots.slice(0, 10)) {
            lines.push(`- page ${screenshot.pageNum}: ${screenshot.outputPath}`);
          }
          if (detailsScreenshots.length > 10) {
            lines.push(`- ...and ${detailsScreenshots.length - 10} more`);
          }
        }

        content.push({ type: "text", text: lines.join("\n") });
        for (const screenshot of detailsScreenshots) {
          content.push({
            type: "image",
            mimeType: "image/png",
            data: (await readFile(screenshot.outputPath)).toString("base64"),
          });
        }

        return {
          content,
          details: {
            sourcePath: input.sourcePath,
            resolvedPath: input.resolvedPath,
            outputDir,
            screenshotDir,
            screenshots: detailsScreenshots,
          },
        };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
