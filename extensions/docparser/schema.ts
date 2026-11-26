import { StringEnum, Type } from "@earendil-works/pi-ai";

import {
  DEFAULT_DPI,
  DEFAULT_MAX_PAGES,
  DEFAULT_NUM_WORKERS,
  MAX_DPI,
  MAX_NUM_WORKERS,
  MAX_PAGES,
  MAX_PAGE_SELECTION_BYTES,
  MAX_SCREENSHOT_PAGES,
  MIN_DPI,
} from "./constants.ts";

export const DocumentParseSchema = Type.Object({
  path: Type.String({
    description:
      "Path to the document file to parse (PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG, TIFF, WebP, etc.)",
  }),
  format: Type.Optional(
    StringEnum(["text", "json"] as const, {
      description: "Output format (default: text)",
    }),
  ),
  targetPages: Type.Optional(
    Type.String({
      maxLength: MAX_PAGE_SELECTION_BYTES,
      description: 'Page selection for parsing, e.g. "1-5,10,15-20"',
    }),
  ),
  screenshotPages: Type.Optional(
    Type.String({
      maxLength: MAX_PAGE_SELECTION_BYTES,
      description: `Page selection for screenshots, e.g. "1-3,8" (maximum ${MAX_SCREENSHOT_PAGES} pages; saved as PNGs).`,
    }),
  ),
  ocr: Type.Optional(
    StringEnum(["auto", "off"] as const, {
      description: "OCR mode: auto uses LiteParse OCR; off disables OCR for faster parsing",
    }),
  ),
  ocrLanguage: Type.Optional(
    Type.String({
      description:
        "Single OCR language code. Built-in Tesseract expects ISO 639-3 codes (eng, deu, fra, jpn); HTTP OCR servers often expect ISO 639-1 codes (en, de, fr, ja).",
    }),
  ),
  ocrLanguages: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description:
        "Multiple OCR language codes; joined into one multilingual string for built-in Tesseract, only the first forwarded to HTTP OCR servers.",
    }),
  ),
  ocrServerUrl: Type.Optional(
    Type.String({
      description: "HTTP OCR server URL implementing the LiteParse OCR API",
    }),
  ),
  numWorkers: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_NUM_WORKERS,
      description: `OCR worker count (default: ${DEFAULT_NUM_WORKERS}, maximum: ${MAX_NUM_WORKERS})`,
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_PAGES,
      description: `Maximum number of pages to parse (default: ${DEFAULT_MAX_PAGES}, maximum: ${MAX_PAGES})`,
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: MIN_DPI,
      maximum: MAX_DPI,
      description: `Rendering DPI for OCR and screenshots (default: ${DEFAULT_DPI})`,
    }),
  ),
  preserveSmallText: Type.Optional(
    Type.Boolean({
      description: "Whether to preserve very small text that would otherwise be filtered out",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description: "Password for encrypted documents",
    }),
  ),
  tessdataPath: Type.Optional(
    Type.String({
      description: "Directory of Tesseract .traineddata files for offline/custom OCR data",
    }),
  ),
});
