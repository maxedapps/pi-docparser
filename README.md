# pi-docparser

A standalone [Pi](https://shittycodingagent.ai/) package that adds local document-understanding tools plus a companion `parse-document` skill for AI agents.

It wraps [`@llamaindex/liteparse`](https://github.com/run-llama/liteparse) 2.10.1, a Rust/PDFium-based local parser. Document processing stays on the local machine, with no LLM parsing or API key required. Built-in OCR may download missing language data unless local `.traineddata` files are supplied; configuring `ocrServerUrl` sends OCR work to that server.

## What this package provides

### Extension tools

This package registers three tools:

| Tool                  | Purpose                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `document_parse`      | Parse a local document to `text` or stable `json`, save the full result to a temp file, and optionally save screenshots. |
| `document_search`     | Search a local document for a phrase and return bounded page-number and bounding-box hits.                               |
| `document_screenshot` | Render up to four document pages as PNGs, return bounded image blocks, and save every PNG to a temp folder.              |

Use `document_parse` for extraction, `document_search` for citations/source locations, and `document_screenshot` when visual layout, charts, signatures, dense tables, or page appearance matter.

### Skill

Ships a `parse-document` skill that teaches agents to:

- prefer `document_parse` over raw `lit` CLI commands
- choose text vs JSON output deliberately
- request small, explicit page ranges
- search before screenshotting when looking for known text
- use saved output paths for selective follow-up

## Requirements and compatibility

- Node.js 22.19 or newer
- Pi installed and working; Pi 0.83 is the development and test baseline
- local machine access to readable regular files you want to parse
- LibreOffice for many Office, presentation, and spreadsheet conversion paths

The Pi core peer ranges follow Pi's `"*"` package policy. That avoids pinning the host's core packages; it does not promise compatibility with every historical Pi version.

The Node floor, safer defaults and hard limits, removal of all-page screenshot behavior, bounded result details, and stable projected JSON are 4.0.0 breaking changes.

## Installation

Install directly with Pi:

```bash
pi install github:inno1314/pi-docparser
```

Or via Git URL:

```bash
pi install git+https://github.com/inno1314/pi-docparser.git
```

### Oh My Pi (`omp`)

```bash
omp plugin install github:inno1314/pi-docparser
```

Or upstream npm release:

```bash
pi install npm:pi-docparser
```

## Example model tool calls

These are representative tool calls Pi may make internally. Prefer small page ranges and repeat with the next bounded range when needed.

### Extract plain text

```text
document_parse({
  path: "./docs/contract.pdf",
  targetPages: "1-10"
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
  targetPages: "1-10",
  maxResults: 50
})
```

Returns bounded hits with page numbers and bounding boxes, useful for citations and deciding which pages to screenshot.

### Render pages for visual inspection

```text
document_screenshot({
  path: "./reports/financial-report.pdf",
  pages: "4",
  dpi: 150
})
```

Omitting `pages` renders page 1. A call may name at most four explicit pages; `all` and `*` are rejected. Use bounded repeated calls for more pages.

### Parse and save screenshots together

```text
document_parse({
  path: "./reports/financial-report.pdf",
  targetPages: "1-4",
  screenshotPages: "2,4"
})
```

The parse result and screenshots are separate artifacts. If optional screenshot rendering fails, the completed parse output remains available and the tool returns a warning.

### Parse a password-protected document

```text
document_parse({
  path: "./docs/protected.pdf",
  targetPages: "1-5",
  password: "user-provided-password"
})
```

### Use offline/custom OCR data

```text
document_parse({
  path: "./scans/report.pdf",
  targetPages: "1-5",
  ocr: "auto",
  ocrLanguage: "eng",
  tessdataPath: "/path/to/tessdata"
})
```

`tessdataPath` points LiteParse/Tesseract at locally supplied `.traineddata` files. This is useful for air-gapped environments, predictable offline operation, or custom language packs. Without supplied local language data, built-in OCR may download missing data.

## Stable JSON contract

`format: "json"` writes a project-owned, stable `{ pages, text }` projection rather than the raw upstream LiteParse object:

```json
{
  "pages": [
    {
      "pageNum": 1,
      "width": 612,
      "height": 792,
      "text": "...",
      "textItems": [
        {
          "text": "Revenue",
          "x": 72,
          "y": 120,
          "width": 48,
          "height": 12,
          "fontName": "Helvetica",
          "fontSize": 12,
          "confidence": 0.99
        }
      ]
    }
  ],
  "text": "..."
}
```

Every page contains `pageNum`, `width`, `height`, `text`, and `textItems`. Every text item contains `text`, `x`, `y`, `width`, and `height`; `fontName`, `fontSize`, and `confidence` are optional. Upstream-only fields such as `markdown`, `images`, `imageErrorCount`, and metadata are not exposed implicitly. The artifact is compact JSON and field order is stable.

Removed LiteParse v1 options are not supported:

- `preciseBoundingBox`
- `preserveLayoutAlignmentAcrossPages`

Use JSON `textItems`, `document_search`, `document_screenshot`, or a narrower `targetPages` selection instead.

## Defaults and limits

Requests are rejected rather than silently clamped.

| Behavior                           | Default                                      | Limit                                                             |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Pages parsed/searched (`maxPages`) | 100                                          | 1–1000                                                            |
| OCR workers (`numWorkers`)         | `min(4, max(1, availableParallelism() - 1))` | 1–8                                                               |
| OCR/rendering DPI (`dpi`)          | 150                                          | 72–300                                                            |
| Search hits (`maxResults`)         | 50                                           | 1–200                                                             |
| Search phrase                      | —                                            | nonblank; 4 KiB UTF-8                                             |
| Page-selection input               | —                                            | 16 KiB UTF-8, 1000 tokens, 1000 pages of pre-dedup expansion work |
| Page number                        | —                                            | 1–4,294,967,295                                                   |
| Screenshot selection               | page 1 for `document_screenshot`             | at most 4 explicit pages; no `all` or `*`                         |

`maxPages` counts pages actually parsed or explicitly selected, not the highest sparse page number. For example, `targetPages: "2,100"` selects two pages. `document_parse.screenshotPages` is optional and creates no screenshots when omitted; when supplied, it follows the same explicit four-page limit.

Safety budgets:

- parsed text or JSON artifact: 256 MiB
- saved screenshot: 25 MiB per PNG and 64 MiB per screenshot job
- inline screenshot images: 3 MiB per PNG and 12 MiB raw total per tool result
- worker request/response: 64 KiB/1 MiB, with a 64 KiB retained stderr tail
- native operation timeout: one internal, non-configurable 10-minute deadline, starting when the job reaches the front of the queue

A PNG omitted from inline image blocks because of the inline limits is still saved, and its path is returned for follow-up inspection.

## Isolation, cancellation, and failures

All parse, search, and screenshot native work shares one fair FIFO per extension activation. Each active operation runs in a fresh child process, so LiteParse/PDFium/Tesseract native crashes, aborts, or fatal worker out-of-memory failures become tool failures instead of bringing down the Pi process. The parent process does not import LiteParse's native module.

Queued cancellation removes the job before a worker starts. Active cancellation and the internal 10-minute timeout terminate the worker process tree and wait for teardown before another native job starts. Cancellation, timeout, native crash, protocol failure, and ordinary parse errors are reported distinctly. If process teardown cannot be confirmed, the executor fails closed and rejects later jobs for that activation.

On Windows, descendant cleanup after an instantaneous native worker crash is best effort because the root may exit before the process tree can be addressed. This does not weaken containment of the Pi process itself.

## Output paths and previews

Successful full outputs are written to OS temporary directories and returned in the tool result:

- `document_parse`: `.../pi-document-parse-*/parsed.txt` or `parsed.json`
- optional parse screenshots: `.../pi-document-parse-*/screenshots/page_<n>.png`
- `document_screenshot`: `.../pi-document-screenshot-*/screenshots/page_<n>.png`

`document_parse` returns only a 20-line/2 KiB preview plus the saved path. Use `read` on that path for the full content. `document_screenshot` returns eligible bounded image blocks and paths for every saved PNG; use the paths for images omitted from inline content. Outputs remain temporary by default—copy them to a chosen persistent location when the user requests durable artifacts.

## Supported inputs

This package supports LiteParse's local formats, including:

- PDF
- DOC / DOCX / DOCM / ODT / RTF / Pages
- PPT / PPTX / PPTM / ODP / Keynote
- XLS / XLSX / XLSM / ODS / CSV / TSV / Numbers
- PNG / JPG / JPEG / GIF / BMP / TIFF / WebP / SVG

LiteParse 2.10.1 handles image conversion natively, with no external image-conversion tool required. Many Office, presentation, and spreadsheet formats still require LibreOffice.

## Tool behavior notes

### `document_parse`

- Writes bounded plain text or the stable projected JSON contract to a temp file.
- Returns a bounded preview and the full output path.
- Supports `targetPages`, OCR options, `password`, `tessdataPath`, and optional explicit `screenshotPages`.
- Defaults `maxPages` to 100.
- Enforces a hard `maxPages` maximum of 1000.

### `document_search`

- Parses and searches inside the isolated native worker.
- Returns projected hits with `pageNum`, `text`, `x`, `y`, `width`, `height`, and optional confidence/font data.
- Reports count or response-byte truncation explicitly.
- Use before screenshotting when searching for known text.

### `document_screenshot`

- Renders one page at a time, up to four explicit pages, and saves every PNG.
- Returns only PNGs within the inline image budgets as image content blocks.
- Can render supported non-PDF documents when required Office conversion tools are installed.

### OCR notes

LiteParse uses built-in native Tesseract OCR by default when OCR is enabled and no `ocrServerUrl` is provided.

- OCR is selective: LiteParse OCRs text-sparse pages or image regions rather than blindly OCRing everything.
- Built-in Tesseract typically uses ISO 639-3 language codes such as `eng`, `deu`, `fra`, `jpn`.
- Many HTTP OCR servers instead expect ISO 639-1 codes such as `en`, `de`, `fr`, `ja`.
- `ocrLanguages` is joined into a multilingual language string for built-in Tesseract.
- When `ocrServerUrl` is used, only the first entry from `ocrLanguages` is forwarded.
- Built-in OCR may download missing language data. For local-only language data, use `tessdataPath` or set `TESSDATA_PREFIX` to supplied `.traineddata` files.

## Host dependencies

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

## Doctor command

If parsing fails because LibreOffice is missing, the extension points users to:

```text
/docparser:doctor
```

Run it inside Pi to:

- detect the current operating system
- check whether LibreOffice is available
- optionally focus the check on a specific file path
- suggest install commands for the current machine
- optionally attempt those install commands after user confirmation when safe to automate

Examples:

```text
/docparser:doctor
/docparser:doctor @./slides.pptx
```

## Known limitations

- OCR quality depends on scan quality, page layout, the chosen language, and available language data.
- Office-family conversion paths may depend on LibreOffice.
- Successful artifacts remain in temporary directories until OS cleanup; copy files that must persist.
- A worker may still exhaust its own memory, but child-process isolation prevents that failure from terminating Pi.
- Native LiteParse npm packages are platform-specific; unsupported platforms need upstream LiteParse support.

## Third-party dependency: LiteParse

This package depends on:

- [`@llamaindex/liteparse`](https://github.com/run-llama/liteparse) 2.10.1
- license: Apache-2.0
- purpose: local document parsing, OCR, screenshots, search, and conversion support

LiteParse documents its upstream dependencies and platform requirements. See:

- repository: https://github.com/run-llama/liteparse
- npm package: https://www.npmjs.com/package/@llamaindex/liteparse
- docs: https://developers.llamaindex.ai/liteparse/

Additional attribution details are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

This package is licensed under the MIT License. See [LICENSE](./LICENSE).
