import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

import { PREVIEW_MAX_BYTES, PREVIEW_MAX_LINES } from "./constants.ts";
import { appendDoctorHint, getMissingHostDependencyMessage } from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import {
  buildLiteParseConfig,
  getProvidedRemovedV1Options,
  getRemovedV1OptionsMessage,
} from "./liteparse-config.ts";
import { runNativeDocumentJob } from "./native-runner.ts";
import type { NativeSearchHit, NativeSearchResult } from "./native-protocol.ts";

const DocumentSearchSchema = Type.Object({
  path: Type.String({
    description: "Path to the document file to search",
  }),
  phrase: Type.String({
    description: "Phrase to search for in the parsed document",
  }),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description: "Whether phrase matching should be case-sensitive (default: false)",
    }),
  ),
  targetPages: Type.Optional(
    Type.String({
      description: 'Optional page selection for parsing/searching, e.g. "1-5,10"',
    }),
  ),
  ocr: Type.Optional(
    StringEnum(["auto", "off"] as const, {
      description:
        "OCR mode: auto uses LiteParse OCR behavior, off disables OCR for faster parsing",
    }),
  ),
  ocrLanguage: Type.Optional(
    Type.String({
      description: "Optional single OCR language code, e.g. eng, deu, fra, jpn",
    }),
  ),
  ocrLanguages: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: "Optional multiple OCR language codes for built-in Tesseract OCR",
    }),
  ),
  ocrServerUrl: Type.Optional(
    Type.String({
      description: "Optional HTTP OCR server URL implementing the LiteParse OCR API",
    }),
  ),
  numWorkers: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional OCR worker count (default: CPU cores - 1)",
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: 72,
      description: "Rendering DPI for OCR (default: 150)",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description: "Optional password for encrypted or password-protected documents",
    }),
  ),
  tessdataPath: Type.Optional(
    Type.String({
      description: "Optional path to Tesseract .traineddata files for offline/custom OCR data",
    }),
  ),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum number of search hits to return (default: 50)",
    }),
  ),
});

type DocumentSearchParams = Static<typeof DocumentSearchSchema>;

function formatHit(hit: NativeSearchHit): string {
  return `p${hit.pageNum} [${hit.x.toFixed(1)}, ${hit.y.toFixed(1)} ${hit.width.toFixed(1)}×${hit.height.toFixed(1)}] ${hit.text}`;
}

function buildFriendlyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("LibreOffice is not installed") ||
    message.includes("ImageMagick is not installed")
  ) {
    return appendDoctorHint(message);
  }

  return message || "Document search failed.";
}

export function registerDocumentSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_search",
    label: "Document Search",
    description:
      "Search a local document with LiteParse v2 and return phrase hits with page numbers and bounding boxes. Use this for citations, locating quoted text, and deciding which pages to inspect visually.",
    promptSnippet:
      "Search parsed documents for a phrase and get page + bounding-box hits for visual citations.",
    promptGuidelines: [
      "Use document_search when the user asks where text appears in a document or needs source/citation locations.",
      "Use targetPages when the relevant section is known; it is faster than searching the whole document.",
      "Use document_screenshot after document_search when the page area needs visual inspection.",
    ],
    parameters: DocumentSearchSchema,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Document search was cancelled before it started." }],
          details: {},
        };
      }

      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) {
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      }

      const params = rawParams as DocumentSearchParams;

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) {
          throw new Error(missingHostDependencyMessage);
        }

        const warnings: string[] = [];
        const parserConfig = buildLiteParseConfig(
          {
            ...params,
            format: "json",
            maxPages: undefined,
            preserveSmallText: false,
          },
          warnings,
        );
        const maxResults = params.maxResults ?? 50;
        const searchResult = await runNativeDocumentJob<NativeSearchResult>(
          {
            operation: "search",
            filePath: input.resolvedPath,
            parserConfig,
            phrase: params.phrase,
            caseSensitive: params.caseSensitive ?? false,
            maxResults,
          },
          { signal },
        );
        const hits = searchResult.hits;

        const hitLines = hits.map(formatHit).join("\n");
        const truncation = truncateHead(hitLines, {
          maxLines: PREVIEW_MAX_LINES,
          maxBytes: PREVIEW_MAX_BYTES,
        });
        const lines = [
          `Searched document: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Phrase: ${params.phrase}`,
          `Hits returned: ${hits.length}${hits.length >= maxResults ? ` (capped at ${maxResults})` : ""}`,
        ];

        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const warning of warnings) lines.push(`- ${warning}`);
        }

        if (truncation.content.trim()) {
          lines.push("Hits:");
          lines.push(truncation.content.trim());
        }

        if (truncation.truncated) {
          lines.push(
            "Hit preview truncated. Use the structured tool details for the complete returned hit list.",
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            sourcePath: input.sourcePath,
            resolvedPath: input.resolvedPath,
            phrase: params.phrase,
            caseSensitive: params.caseSensitive ?? false,
            hits,
            truncated: truncation.truncated,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
