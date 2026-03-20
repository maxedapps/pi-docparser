---
name: parse-document
description: Use this skill when the user wants to parse local documents and extract content from PDFs, Word or DOCX files, PowerPoint or PPTX decks, Excel/XLSX or CSV spreadsheets, or images such as PNG, JPG, TIFF, and WebP. It helps the agent use the dedicated `document_parse` tool efficiently for plain text extraction, layout-aware JSON with coordinates and bounding boxes, OCR, page-limited parsing, and PDF screenshots.
license: MIT
compatibility: Requires a `document_parse` tool, such as the one provided by the pi-docparser package.
metadata:
  author: Maximilian Schwarzmüller + pi
  primary-interface: document_parse tool
---

# Parse Document

Use the dedicated `document_parse` tool as the default interface. Do not fall back to manual `lit` CLI commands unless the user explicitly asks for the raw command line workflow or the extension tool is unavailable.

## Efficient tool usage

### Choose the smallest useful output

- Use `format: "text"` when the user wants to read, summarize, quote, search, or review the document.
- Use `format: "json"` when the user needs structured page data, text positions, or bounding boxes.
- Avoid asking for JSON unless coordinates or programmatic structure actually matter.

### Limit scope early

If the task concerns only part of a document, pass `targetPages` instead of parsing everything.

Examples:

- a single chapter
- a cited appendix
- a page range from the user
- a specific page mentioned in an error report or screenshot request

### Use OCR deliberately

- Use `ocr: "off"` for native-text PDFs when OCR is unnecessary.
- Leave OCR on automatic behavior for scanned PDFs or image-heavy documents.
- Use `ocrLanguage` for a single OCR language.
- Use `ocrLanguages` only when you truly need multilingual OCR.
- Built-in Tesseract usually expects ISO 639-3 codes such as `eng`, `deu`, `fra`, or `jpn`.
- Many HTTP OCR servers instead expect ISO 639-1 codes such as `en`, `de`, `fr`, or `ja`.
- Increase `dpi` only when OCR quality or screenshot readability really needs it.
- Use `ocrServerUrl` only when the user already has or wants an external OCR server.

Note: on the first OCR run, LiteParse may download Tesseract language/model data.

### Use screenshots only when text is not enough

Request `screenshotPages` when the task depends on visual layout, charts, handwriting, dense tables, or page appearance.

Do not request screenshots by default.

Important constraints:

- screenshots are currently generated only for PDF inputs
- screenshot output is PNG-based in this extension
- use `screenshotPages: "all"` to render all PDF pages when needed

## Follow-up workflow

The tool writes parsed output to temporary files and returns their paths.

After calling it:

1. inspect the returned parsed output path with `read`
2. inspect screenshot paths with `read` when visual review is needed
3. only copy files into the project if the user actually wants persistent artifacts

Do not ask the tool to inline an entire large document into context. Let it save the full result, then inspect the returned files selectively.

## Important constraints and expectations

- Office documents and spreadsheets may require LibreOffice on the host machine.
- Image inputs may require ImageMagick on the host machine.
- The tool surfaces those missing dependencies as friendly errors; do not misdiagnose them as generic parser failures.
- Parsed outputs are temporary by default. If the user wants durable files in the repo or a chosen folder, copy the returned temp files afterward.
- Screenshot output is PNG-based in this extension.
- The tool accepts PI-style paths such as `@relative/file.pdf` and `~/Documents/file.pdf`.

## Good default patterns

### Summarize or review a document

Use:

- `format: "text"`
- `targetPages` if only part of the document matters
- `ocr: "off"` for clearly native-text PDFs

Then inspect the returned text file with `read`.

### Extract positions or bounding boxes

Use:

- `format: "json"`
- `targetPages` when possible

Then inspect the JSON file with `read`.

### Review a visually complex page

Use:

- text or JSON parsing as needed
- `screenshotPages` for the relevant PDF pages
- higher `dpi` only if readability is a problem

Then inspect the generated screenshots with `read`.

### Parse a scanned or image-based document

Use:

- OCR enabled
- `ocrLanguage` or `ocrLanguages` when the document language is known
- optionally higher `dpi`
- JSON only if positional data matters

## Parameter reminders

The tool supports these high-value parameters:

- `path`
- `format`
- `targetPages`
- `screenshotPages`
- `ocr`
- `ocrLanguage`
- `ocrLanguages`
- `ocrServerUrl`
- `numWorkers`
- `maxPages`
- `dpi`
- `preciseBoundingBox`
- `preserveSmallText`
- `preserveLayoutAlignmentAcrossPages`

Prefer a minimal parameter set. Only add advanced options when the task clearly benefits from them.
