# pi-docparser

A standalone [pi](https://shittycodingagent.ai/) package that adds local document-understanding tools plus a companion `parse-document` skill for AI agents.

It wraps [`@llamaindex/liteparse`](https://github.com/run-llama/liteparse) v2, a Rust/PDFium-based local parser. Documents stay on the local machine: no cloud calls, no LLM parsing, no API keys.

## What this package provides

### Extension tools

This package registers three tools:

| Tool                  | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `document_parse`      | Parse a local document to `text` or `json`, save the full result to a temp file, and optionally render screenshots.        |
| `document_search`     | Search a local document for a phrase and return page numbers plus bounding boxes for each hit.                             |
| `document_screenshot` | Render document pages as PNG images, return image blocks for direct model inspection, and save PNG files to a temp folder. |

Use `document_parse` for extraction, `document_search` for citations/source locations, and `document_screenshot` when visual layout, charts, signatures, dense tables, or page appearance matter.

### Skill

Ships a `parse-document` skill that teaches agents to:

- prefer `document_parse` over raw `lit` CLI commands
- choose text vs JSON output deliberately
- search before screenshotting when looking for known text
- use screenshots only when visual inspection is useful
- keep large parsed outputs out of context until needed

## LiteParse v2 behavior

LiteParse v2 is a Rust rewrite using PDFium for text extraction/rendering and native Tesseract for OCR. Compared with v1, it is substantially faster and exposes a simpler Node API.

`pi-docparser` adds two safety boundaries around that native code:

1. all document operations enter a module-global FIFO queue, so parallel Pi tool calls never invoke PDFium concurrently
2. every operation runs in a one-shot child process, so a native `SIGABRT` or `SIGSEGV` terminates only the worker and is reported as a normal tool error while Pi keeps running

The bundled LiteParse version also contains its own process-global PDFium mutex. The outer queue and process boundary are intentional defense in depth.

```ts
const result = await parser.parse("document.pdf");
// result = { pages: ParsedPage[], text: string }

const screenshots = await parser.screenshot("document.pdf", [1, 2]);
```

JSON output from `document_parse` is the full LiteParse v2 parse result:

```json
{
  "pages": [
    {
      "pageNum": 1,
      "width": 612,
      "height": 792,
      "text": "...",
      "textItems": [{ "text": "Revenue", "x": 72, "y": 120, "width": 48, "height": 12 }]
    }
  ],
  "text": "..."
}
```

Removed LiteParse v1 options are not supported:

- `preciseBoundingBox`
- `preserveLayoutAlignmentAcrossPages`

Alternatives for agents: use JSON `textItems` bounding boxes, `document_search`, `document_screenshot`, or narrower `targetPages`.

## Supported inputs

This package uses LiteParse and supports the formats LiteParse supports locally, including:

- PDF
- DOC / DOCX / DOCM / ODT / RTF / Pages
- PPT / PPTX / PPTM / ODP / Keynote
- XLS / XLSX / XLSM / ODS / CSV / TSV / Numbers
- PNG / JPG / JPEG / GIF / BMP / TIFF / WebP / SVG

Support for non-PDF formats may depend on host tools such as LibreOffice or ImageMagick. See [Host dependencies](#host-dependencies).

## Requirements

- pi installed and working
- Node.js 20.6+
- local machine access to the files you want to parse

## Installation

```bash
pi install npm:pi-docparser
```

Or from GitHub:

```bash
pi install git:github.com/maxedapps/pi-docparser
```

## Example model tool calls

These are representative tool calls pi may make internally.

### Extract plain text

```text
document_parse({
  path: "./docs/contract.pdf"
})
```

Useful for summarizing, quoting, reviewing, or answering questions where layout coordinates are not needed.

### Extract JSON with bounding boxes

```text
document_parse({
  path: "./reports/financial-report.pdf",
  format: "json",
  targetPages: "1-3"
})
```

Useful when an agent needs page structure, text coordinates, or bounding boxes.

### Search for a phrase and get source locations

```text
document_search({
  path: "./reports/financial-report.pdf",
  phrase: "Revenue grew",
  targetPages: "1-10"
})
```

Returns each hit with page number and bounding box, useful for citations and deciding which pages to screenshot.

### Render pages for visual inspection

```text
document_screenshot({
  path: "./reports/financial-report.pdf",
  pages: "4",
  dpi: 150
})
```

Useful for charts, figures, signatures, dense tables, and cases where extracted text is insufficient.

### Parse a password-protected document

```text
document_parse({
  path: "./docs/protected.pdf",
  password: "user-provided-password"
})
```

### Use offline/custom OCR data

```text
document_parse({
  path: "./scans/report.pdf",
  ocr: "auto",
  ocrLanguage: "eng",
  tessdataPath: "/path/to/tessdata"
})
```

`tessdataPath` points LiteParse/Tesseract at local `.traineddata` files. Most users do not need it; it is useful for air-gapped environments or custom language packs.

## Tool behavior notes

### `document_parse`

- Queues safely behind any other active document operation; concurrent tool calls are processed one at a time.
- Runs native parsing in an isolated child process so a PDFium crash cannot terminate Pi.
- Saves full parsed output to a temporary `.txt` or `.json` file.
- Returns a short preview to avoid flooding model context.
- Supports `targetPages`, OCR options, `password`, `tessdataPath`, and optional `screenshotPages`.
- Defaults `maxPages` to LiteParse v2's default: `1000`.

### `document_search`

- Parses the document and searches page `textItems` with LiteParse's `searchItems` helper.
- Returns structured hits with `pageNum`, `text`, `x`, `y`, `width`, `height`, and optional confidence/font data.
- Use before screenshotting when searching for known text.

### `document_screenshot`

- Renders pages as PNG screenshots.
- Returns image content blocks the model can inspect directly.
- Also saves screenshots to temporary files and returns their paths.
- Can render supported non-PDF documents when required host conversion tools are installed.

### OCR notes

LiteParse v2 uses built-in native Tesseract OCR by default when OCR is enabled and no `ocrServerUrl` is provided.

Important details:

- OCR is selective: LiteParse OCRs text-sparse pages or image regions rather than blindly OCRing everything.
- Built-in Tesseract typically uses ISO 639-3 language codes such as `eng`, `deu`, `fra`, `jpn`.
- Many HTTP OCR servers instead expect ISO 639-1 codes such as `en`, `de`, `fr`, `ja`.
- `ocrLanguages` is joined into a multilingual language string for built-in Tesseract.
- When `ocrServerUrl` is used, only the first entry from `ocrLanguages` is forwarded.
- For offline/custom OCR data, use `tessdataPath` or set `TESSDATA_PREFIX`.

## Host dependencies

This package relies on LiteParse for local parsing and conversion. Depending on the input format, you may need additional host tools installed.

The tools perform lightweight preflight checks for the most common host dependencies and also forward LiteParse's original error messages when conversion fails.

### LibreOffice

Needed for many Office document, presentation, and spreadsheet conversion paths.

```bash
# macOS
brew install --cask libreoffice

# Ubuntu / Debian
apt-get install libreoffice

# Windows
choco install libreoffice-fresh
```

### ImageMagick

Needed for image-to-PDF conversion paths.

```bash
# macOS
brew install imagemagick

# Ubuntu / Debian
apt-get install imagemagick

# Windows
choco install imagemagick.app
```

## Doctor command

If parsing fails because a host dependency is missing, the extension points users to:

```text
/docparser:doctor
```

Run it inside pi to:

- detect the current operating system
- check whether LibreOffice and ImageMagick are available
- optionally focus the check on a specific file path
- suggest install commands for the current machine
- optionally attempt those install commands after user confirmation when that looks safe to automate

Examples:

```text
/docparser:doctor
/docparser:doctor @./slides.pptx
```

## Native worker safety and timeouts

All three tools share one FIFO queue. If an agent submits seven parses simultaneously, the requests remain concurrent at the Pi tool layer but enter LiteParse one at a time.

Each queued operation receives a fresh worker process. The default timeout is 10 minutes. Set `PI_DOCPARSER_TIMEOUT_MS` to a positive millisecond value when exceptionally large OCR jobs need a different limit. Cancellation terminates the active worker and releases the queue for the next request.

A native worker crash is reported with its exit signal and containment status. Retrying may help after an environmental failure, but repeatedly crashing on one document should be reported upstream with the PDFium/LiteParse crash log.

## Known limitations

- Native process isolation prevents a parser crash from terminating Pi, but it cannot make every malformed document parse successfully.
- Document operations are intentionally serialized, so a large batch trades throughput for PDFium stability.
- OCR quality depends on scan quality, page layout, and the chosen OCR language.
- Some conversion paths depend on external host tools.
- Full parse and screenshot outputs are written to temporary files by default, not directly into your repository.
- Native LiteParse v2 npm packages are platform-specific; unsupported platforms may need upstream LiteParse support first.

## Third-party dependency: LiteParse

This package depends on:

- [`@llamaindex/liteparse`](https://github.com/run-llama/liteparse)
- license: Apache-2.0
- purpose: local document parsing, OCR, screenshots, search, and conversion support

LiteParse itself documents its own upstream dependencies and platform requirements. See:

- repository: https://github.com/run-llama/liteparse
- npm package: https://www.npmjs.com/package/@llamaindex/liteparse
- docs: https://developers.llamaindex.ai/liteparse/

Additional attribution details are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

This package is licensed under the MIT License. See [LICENSE](./LICENSE).
