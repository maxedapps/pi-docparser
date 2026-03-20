import { DEFAULT_DPI, DEFAULT_MAX_PAGES, DEFAULT_NUM_WORKERS } from "./constants.ts";
import { resolveScreenshotSelection } from "./input.ts";
import type { DocumentParseParams, DocumentParsePlan, LiteParseToolConfig } from "./types.ts";

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveOcrLanguage(
  params: DocumentParseParams,
  ocrServerUrl: string | undefined,
  warnings: string[],
): LiteParseToolConfig["ocrLanguage"] | undefined {
  const singleOcrLanguage = normalizeOptionalString(params.ocrLanguage);
  const ocrLanguages = (params.ocrLanguages ?? [])
    .map((language) => language.trim())
    .filter(Boolean);

  if (singleOcrLanguage && ocrLanguages.length > 0) {
    warnings.push("Both ocrLanguage and ocrLanguages were provided. Using ocrLanguages.");
  }

  if (ocrLanguages.length === 0) {
    return singleOcrLanguage;
  }

  if (ocrServerUrl) {
    if (ocrLanguages.length > 1) {
      warnings.push(
        "Multiple OCR languages were provided, but HTTP OCR servers currently receive only the first language code.",
      );
    }

    return ocrLanguages[0];
  }

  return ocrLanguages.join("+");
}

export function buildDocumentParsePlan(params: DocumentParseParams): DocumentParsePlan {
  const warnings: string[] = [];
  const ocrServerUrl = normalizeOptionalString(params.ocrServerUrl);
  const ocrLanguage = resolveOcrLanguage(params, ocrServerUrl, warnings);

  const parserConfig: LiteParseToolConfig = {
    outputFormat: params.format ?? "text",
    ocrEnabled: (params.ocr ?? "auto") !== "off",
    ocrLanguage,
    ocrServerUrl,
    numWorkers: params.numWorkers ?? DEFAULT_NUM_WORKERS,
    maxPages: params.maxPages ?? DEFAULT_MAX_PAGES,
    targetPages: normalizeOptionalString(params.targetPages),
    dpi: params.dpi ?? DEFAULT_DPI,
    preciseBoundingBox: params.preciseBoundingBox ?? true,
    preserveVerySmallText: params.preserveSmallText ?? false,
    preserveLayoutAlignmentAcrossPages: params.preserveLayoutAlignmentAcrossPages ?? false,
  };

  return {
    parserConfig,
    screenshotSelection: params.screenshotPages
      ? resolveScreenshotSelection(params.screenshotPages)
      : undefined,
    warnings,
  };
}
