import { StringEnum, Type } from "@mariozechner/pi-ai";

export const DocumentParseSchema = Type.Object({
  path: Type.String({
    description:
      "Path to the document file to parse (PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG, TIFF, WebP, etc.)",
  }),
  format: Type.Optional(
    StringEnum(["text", "json"] as const, {
      description: "Output format for the parsed document (default: text)",
    }),
  ),
  targetPages: Type.Optional(
    Type.String({
      description: 'Optional page selection for parsing, e.g. "1-5,10,15-20"',
    }),
  ),
  screenshotPages: Type.Optional(
    Type.String({
      description:
        'Optional PDF page selection for screenshots, e.g. "1-3,8" or "all". Screenshots are currently generated only for PDF inputs and are saved as PNG files.',
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
      description:
        "Optional single OCR language code. Built-in Tesseract typically uses ISO 639-3 codes such as eng, deu, fra, jpn. Many HTTP OCR servers instead expect ISO 639-1 codes such as en, de, fr, ja.",
    }),
  ),
  ocrLanguages: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description:
        "Optional multiple OCR language codes. For built-in Tesseract they are joined into a multilingual language string. For HTTP OCR servers, only the first code is forwarded.",
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
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum number of pages to parse (default: 10000)",
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: 72,
      description: "Rendering DPI for OCR and screenshots (default: 150)",
    }),
  ),
  preciseBoundingBox: Type.Optional(
    Type.Boolean({
      description: "Whether to compute precise bounding boxes (default: true)",
    }),
  ),
  preserveSmallText: Type.Optional(
    Type.Boolean({
      description: "Whether to preserve very small text that would otherwise be filtered out",
    }),
  ),
  preserveLayoutAlignmentAcrossPages: Type.Optional(
    Type.Boolean({
      description:
        "Whether to preserve text alignment consistently across page boundaries (default: false)",
    }),
  ),
});
