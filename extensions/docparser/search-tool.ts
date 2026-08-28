import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DPI,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULTS,
  DEFAULT_NUM_WORKERS,
  MAX_DPI,
  MAX_NUM_WORKERS,
  MAX_PAGES,
  MAX_PAGE_SELECTION_BYTES,
  MAX_RESULTS,
  MAX_SEARCH_PHRASE_BYTES,
  MIN_DPI,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_LINES,
} from "./constants.ts";
import {
  appendDoctorHint,
  getMissingHostDependencyMessage,
  isDependencySetupMessage,
} from "./deps.ts";
import { resolveDocumentTarget, validateSearchPhrase } from "./input.ts";
import {
  buildLiteParseConfig,
  getProvidedRemovedV1Options,
  getRemovedV1OptionsMessage,
} from "./liteparse-config.ts";
import { formatNativeExecutionError, NativeExecutionError } from "./native-executor.ts";
import type { DocumentSearchDetails, NativeExecutor, NativeSearchHit } from "./types.ts";

export const DocumentSearchSchema = Type.Object({
  path: Type.String({ description: "Path to the document file to search" }),
  phrase: Type.String({
    maxLength: MAX_SEARCH_PHRASE_BYTES,
    description: `Phrase to search for in the parsed document (maximum ${MAX_SEARCH_PHRASE_BYTES} UTF-8 bytes)`,
  }),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description: "Whether phrase matching should be case-sensitive (default: false)",
    }),
  ),
  targetPages: Type.Optional(
    Type.String({
      maxLength: MAX_PAGE_SELECTION_BYTES,
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
    Type.String({ description: "Optional single OCR language code, e.g. eng, deu, fra, jpn" }),
  ),
  ocrLanguages: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: "Optional multiple OCR language codes for built-in Tesseract OCR",
    }),
  ),
  ocrServerUrl: Type.Optional(
    Type.String({ description: "Optional HTTP OCR server URL implementing the LiteParse OCR API" }),
  ),
  numWorkers: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_NUM_WORKERS,
      description: `Optional OCR worker count (default: ${DEFAULT_NUM_WORKERS}, maximum: ${MAX_NUM_WORKERS})`,
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_PAGES,
      description: `Maximum number of pages to search (default: ${DEFAULT_MAX_PAGES}, maximum: ${MAX_PAGES})`,
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: MIN_DPI,
      maximum: MAX_DPI,
      description: `Rendering DPI for OCR (default: ${DEFAULT_DPI})`,
    }),
  ),
  password: Type.Optional(
    Type.String({ description: "Optional password for encrypted or password-protected documents" }),
  ),
  tessdataPath: Type.Optional(
    Type.String({
      description: "Optional path to Tesseract .traineddata files for offline/custom OCR data",
    }),
  ),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_RESULTS,
      description: `Maximum number of search hits to return (default: ${DEFAULT_MAX_RESULTS}, maximum: ${MAX_RESULTS})`,
    }),
  ),
});

type DocumentSearchParams = Static<typeof DocumentSearchSchema>;

function formatHit(hit: NativeSearchHit): string {
  return `p${hit.pageNum} [${hit.x.toFixed(1)}, ${hit.y.toFixed(1)} ${hit.width.toFixed(1)}×${hit.height.toFixed(1)}] ${hit.text}`;
}

function buildFriendlyErrorMessage(error: unknown): string {
  const message =
    error instanceof NativeExecutionError
      ? formatNativeExecutionError(error, "Document search failed.")
      : error instanceof Error
        ? error.message
        : String(error);
  return isDependencySetupMessage(message)
    ? appendDoctorHint(message)
    : message || "Document search failed.";
}

export function registerDocumentSearchTool(pi: ExtensionAPI, executor: NativeExecutor): void {
  pi.registerTool({
    name: "document_search",
    label: "Document Search",
    description:
      "Search a local document with LiteParse v2 and return bounded projected phrase hits with page numbers and bounding boxes.",
    promptSnippet:
      "Search parsed documents for a phrase and get page + bounding-box hits for visual citations.",
    promptGuidelines: [
      "Use document_search when the user asks where text appears in a document or needs source/citation locations.",
      "By default, document_search searches the first 100 pages of a document. If searching large documents (>100 pages), specify maxPages (e.g. 1000) or targetPages (e.g. '100-300').",
      "Use targetPages when the relevant section is known; it is faster than searching the whole document.",
      "Use document_screenshot after document_search when the page area needs visual inspection.",
    ],
    parameters: DocumentSearchSchema,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text" as const, text: "Document search was cancelled before it started." },
          ],
          details: {},
        };
      }
      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) throw new Error(getRemovedV1OptionsMessage(removedOptions));
      const params = rawParams as DocumentSearchParams;

      try {
        validateSearchPhrase(params.phrase);
        const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
          throw new Error(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
        }
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) throw new Error(missingHostDependencyMessage);
        const warnings: string[] = [];
        const parserConfig = buildLiteParseConfig(
          { ...params, format: "json", preserveSmallText: false },
          warnings,
        );
        const result = await executor.execute(
          {
            operation: "search",
            inputPath: input.resolvedPath,
            stagingDir: join(tmpdir(), `pi-document-search-${randomUUID()}`),
            phrase: params.phrase,
            caseSensitive: params.caseSensitive ?? false,
            maxResults,
            config: parserConfig,
          },
          { signal },
        );
        const truncation = truncateHead(result.hits.map(formatHit).join("\n"), {
          maxLines: PREVIEW_MAX_LINES,
          maxBytes: PREVIEW_MAX_BYTES,
        });
        const lines = [
          `Searched document: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Pages searched: ${result.pageCount}`,
          `Phrase: ${params.phrase}`,
          `Hits returned: ${result.hits.length}`,
        ];
        const effectiveMaxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
        if (
          !params.targetPages &&
          result.pageCount >= effectiveMaxPages &&
          result.hits.length === 0
        ) {
          lines.push(
            `Note: Search was limited to ${result.pageCount} pages by maxPages (${effectiveMaxPages}). If the document has more pages, increase maxPages or pass targetPages.`,
          );
        }
        if (result.truncatedByCount)
          lines.push(`Hit results were truncated at the ${maxResults}-result limit.`);
        if (result.truncatedByBytes)
          lines.push("Hit results were truncated at the native response byte limit.");
        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const warning of warnings) lines.push(`- ${warning}`);
        }
        if (truncation.content.trim()) lines.push("Hits:", truncation.content.trim());
        if (truncation.truncated)
          lines.push(
            "Hit preview truncated. Use structured tool details for the bounded returned hit list.",
          );
        const details: DocumentSearchDetails = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          phrase: params.phrase,
          caseSensitive: params.caseSensitive ?? false,
          hits: result.hits,
          truncatedByCount: result.truncatedByCount,
          truncatedByBytes: result.truncatedByBytes,
          previewTruncated: truncation.truncated,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
