---
name: parse-document
description: >-
  Use this skill when the user wants to parse, search, or visually inspect local documents such as PDFs,
  Word/DOCX files, PowerPoint/PPTX decks, Excel/XLSX/CSV spreadsheets, or images such as PNG, JPG,
  TIFF, and WebP. It helps the agent use the pi-docparser tools efficiently: document_parse for text/JSON
  extraction, document_search for phrase locations and bounding boxes, and document_screenshot for visual
  page inspection.
license: MIT
compatibility: >-
  Requires document_parse; optionally benefits from document_search and document_screenshot, such as the
  tools provided by the pi-docparser package.
metadata:
  author: Maximilian Schwarzmüller + pi
  primary-interface: document_parse, document_search, document_screenshot tools
---

# Parse Document

Use the dedicated document tools as the default interface. Do not fall back to manual `lit` CLI commands unless the user explicitly asks for the raw command line workflow or the extension tools are unavailable.

## Tool routing

- Use `document_parse` to extract text or JSON from a local document.
- Use `document_search` to find a phrase and get page numbers plus bounding boxes for citations/source locations.
- Use `document_screenshot` to render pages as PNG image blocks when visual layout matters.

Recommended workflow for known text: `document_search` first, then `document_screenshot` only for relevant pages.

## Efficient parsing

### Choose the smallest useful output

- Use `format: "text"` when the user wants to read, summarize, quote, search, or review the document.
- Use `format: "json"` when the user needs structured page data, text positions, or bounding boxes.
- Avoid JSON unless coordinates or programmatic structure matter.

Stable JSON output is shaped like:

```json
{
  "pages": [{ "pageNum": 1, "width": 612, "height": 792, "text": "...", "textItems": [] }],
  "text": "..."
}
```

### Limit scope early

Pass a small, explicit `targetPages` range whenever the task does not require the whole document. Start with the user-named page or a range such as `"1-10"`, then make another bounded call if needed.

Examples:

- a single chapter
- a cited appendix
- a page range from the user
- a specific page mentioned in an error report or screenshot request

Default `maxPages` is `100`.
The hard maximum is `1000`.

### Use OCR deliberately

- Use `ocr: "off"` for native-text PDFs when OCR is unnecessary.
- Leave OCR on automatic behavior for scanned PDFs or image-heavy documents.
- Use `ocrLanguage` for a single OCR language.
- Use `ocrLanguages` only when multilingual OCR is truly needed.
- Built-in Tesseract usually expects ISO 639-3 codes such as `eng`, `deu`, `fra`, or `jpn`.
- Many HTTP OCR servers instead expect ISO 639-1 codes such as `en`, `de`, `fr`, or `ja`.
- Increase `dpi` only when OCR quality or screenshot readability needs it.
- Use `ocrServerUrl` only when the user already has or wants an external OCR server.
- Built-in OCR may download missing language data. Supply local `.traineddata` through `tessdataPath` (or `TESSDATA_PREFIX`) for offline/air-gapped work or custom language data.

### Password-protected documents

If parsing fails because a document is encrypted/password-protected, ask the user for the password and retry with `password`.

## Search workflow

Use `document_search` when the user asks:

- where text appears
- for source/citation locations
- to find all mentions of a phrase
- to identify pages that should be inspected visually

`maxPages` defaults to `100`. For documents larger than 100 pages, pass `maxPages: 1000` to search the full document, or specify `targetPages` (e.g. `"100-300"`).
Use `maxResults` to cap broad searches.

## Screenshot workflow

Use `document_screenshot` when text is not enough, for example:

- charts or figures
- handwriting/signatures
- dense tables
- visual page layout
- forms where spatial relationships matter

Request one to four explicit pages per call. Omit `pages` only when page 1 is intended. Never use `all` or `*`; make bounded repeated calls when the user needs more pages.

`document_parse` also supports `screenshotPages` when parsing and screenshotting should happen together, but prefer the dedicated `document_screenshot` tool for visual-only follow-up.

## Follow-up workflow

`document_parse` writes parsed output to temporary files and returns their paths. `document_screenshot` saves every PNG but only inlines images up to 3 MiB each and 12 MiB raw total per result.

After calling tools:

1. inspect returned parsed output paths with `read` when full content is needed
2. inspect returned screenshot paths with `read`, especially when a warning says an image was not inlined
3. only copy files into the project if the user wants persistent artifacts

Do not inline an entire large document into context. Let the tool save the full result, then inspect selectively.

## Removed LiteParse v1 options

Do not use these removed options:

- `preciseBoundingBox`
- `preserveLayoutAlignmentAcrossPages`

Alternatives:

- use `format: "json"` for LiteParse v2 `textItems` bounding boxes
- use `document_search` for phrase-level bounding boxes
- use `document_screenshot` for visual layout checks
- use `targetPages` to narrow extraction

## Important constraints and expectations

- Office documents and spreadsheets may require LibreOffice on the host machine.
- Image inputs are handled natively without an external image-conversion dependency.
- The tools surface missing dependencies as friendly errors; do not misdiagnose them as generic parser failures.
- Parsed outputs and screenshots are temporary by default. If the user wants durable files in the repo or a chosen folder, copy returned temp files afterward.
- The tools accept pi-style paths such as `@relative/file.pdf` and `~/Documents/file.pdf`.

## Good default patterns

### Summarize or review a document

Use `document_parse` with:

- `format: "text"`
- `targetPages` if only part of the document matters
- `ocr: "off"` for clearly native-text PDFs

Then inspect the returned text file with `read` if needed.

### Extract positions or bounding boxes

Use `document_parse` with:

- `format: "json"`
- `targetPages` when possible

Then inspect the JSON file with `read`.

### Locate a phrase for citation

Use `document_search` with:

- `phrase`
- `targetPages` when possible
- `maxResults` for broad searches

Use returned page/bounding-box hits for citations or screenshot follow-up.

### Review a visually complex page

Use `document_screenshot` with:

- `pages` for a small explicit range of one to four relevant pages
- higher `dpi` only if readability is a problem

### Parse a scanned or image-based document

Use `document_parse` with:

- OCR enabled
- `ocrLanguage` or `ocrLanguages` when the document language is known
- optionally higher `dpi`
- JSON only if positional data matters

## Parameter reminders

High-value `document_parse` parameters:

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
- `preserveSmallText`
- `password`
- `tessdataPath`

Prefer a minimal parameter set. Add advanced options only when the task clearly benefits from them.
