# pi-docparser

A standalone [pi](https://shittycodingagent.ai/) package that adds a `document_parse` tool plus a companion `parse-document` skill for extracting content from local documents.

It wraps [`@llamaindex/liteparse`](https://github.com/run-llama/liteparse) so pi can parse PDFs, Office documents, spreadsheets, CSV files, and common image formats through a dedicated tool instead of ad-hoc shell commands. It can also perform OCR.

When required host tools such as LibreOffice, ImageMagick, or Ghostscript are missing, the tool surfaces actionable install guidance instead of generic conversion failures and points users to `/docparser:doctor` for guided setup.

## What this package provides

### Extension

Registers a `document_parse` tool that can:

- parse local documents to `text` or `json`
- use OCR for scanned or image-based documents
- accept single-language OCR via `ocrLanguage` or multilingual OCR via `ocrLanguages`
- limit parsing to selected page ranges
- preserve layout alignment across page boundaries when needed
- generate PNG screenshots for PDF pages, including `screenshotPages: "all"`
- save full parsed output to temporary files for follow-up inspection with pi's `read` tool

### Skill

Ships a `parse-document` skill that helps pi use the tool efficiently:

- prefer text output unless coordinates matter
- use OCR deliberately
- use screenshots only when visual layout matters
- keep large parsed outputs out of the model context until needed

## Supported inputs

This package uses LiteParse and therefore supports the formats LiteParse supports locally, including:

- PDF
- DOC / DOCX / ODT / RTF
- PPT / PPTX / ODP
- XLS / XLSX / XLSM / ODS
- CSV / TSV
- PNG / JPG / JPEG / GIF / BMP / TIFF / WebP / SVG

Support for non-PDF formats may depend on host tools such as LibreOffice or ImageMagick. See [Host dependencies](#host-dependencies).

## Requirements

- pi installed and working
- Node.js 18+
- local machine access to the files you want to parse

## Installation

### npm install

```bash
pi install npm:pi-docparser
```

### Install from GitHub

```bash
pi install git:github.com/maxedapps/pi-docparser
```

## Example model tool calls

These are representative `document_parse` calls pi may make internally, depending on the user's request:

### 1) Extract plain text from a PDF

```text
document_parse({
  path: "./docs/contract.pdf"
})
```

Useful when the user wants the document summarized, searched, or quoted and layout coordinates are not needed.

### 2) OCR a scanned image or photo

```text
document_parse({
  path: "./scans/receipt.jpg",
  ocr: "auto",
  ocrLanguage: "eng"
})
```

Useful when the source is an image or scanned document and text must be recognized first.

### 3) Extract structured JSON and PDF screenshots for selected pages

```text
document_parse({
  path: "./reports/financial-report.pdf",
  format: "json",
  targetPages: "1-3",
  screenshotPages: "1-2"
})
```

Useful when the user cares about page layout, bounding boxes, or wants visual follow-up on specific PDF pages.

## Tool behavior notes

### OCR notes

LiteParse's built-in Tesseract OCR is used by default when OCR is enabled and no `ocrServerUrl` is provided.

Important details:

- the first OCR run may download Tesseract language/model data
- built-in Tesseract typically uses ISO 639-3 language codes such as `eng`, `deu`, `fra`, `jpn`
- many HTTP OCR servers instead expect ISO 639-1 codes such as `en`, `de`, `fr`, `ja`
- `ocrLanguages` is joined into a multilingual language string for built-in Tesseract
- when `ocrServerUrl` is used, only the first entry from `ocrLanguages` is forwarded

### Screenshots

- screenshot rendering is PDF-only
- screenshot output is PNG-only in this package
- use `screenshotPages: "all"` to render every PDF page
- use page selections like `"1-3,8"` to limit screenshot work

## Host dependencies

This package relies on LiteParse for local parsing and conversion. Depending on the input format, you may need additional host tools installed.

The tool performs a lightweight preflight check for the most common host dependencies and also forwards LiteParse's original error messages when conversion fails.

### LibreOffice

Needed for many Office document and spreadsheet conversion paths.

Examples from LiteParse documentation:

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

### Ghostscript

Some image or vector conversion paths may also require Ghostscript.

## Doctor command

If parsing fails because a host dependency is missing, the extension points users to:

```text
/docparser:doctor
```

Run it inside pi to:

- detect the current operating system
- check whether LibreOffice, ImageMagick, and Ghostscript are available
- optionally focus the check on a specific file path
- suggest the most appropriate install commands for the current machine
- report missing packages as doctor findings instead of making the command look like it failed
- keep the UI visibly busy while automatic install commands are running
- optionally attempt those install commands after user confirmation when that looks safe to automate

Examples:

```text
/docparser:doctor
/docparser:doctor @./slides.pptx
```

## Known limitations

- screenshot rendering is PDF-only and PNG-only
- OCR quality depends on scan quality, page layout, and the chosen OCR language
- some conversion paths depend on external host tools
- output is written to temporary files, not directly into your repository

## Third-party dependency: LiteParse

This package depends on:

- [`@llamaindex/liteparse`](https://github.com/run-llama/liteparse)
- license: Apache-2.0
- purpose: local document parsing, OCR, screenshots, and conversion support

LiteParse itself documents its own upstream dependencies and platform requirements. See:

- repository: https://github.com/run-llama/liteparse
- npm package: https://www.npmjs.com/package/@llamaindex/liteparse
- docs: https://developers.llamaindex.ai/liteparse/

Additional attribution details are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

This package is licensed under the MIT License. See [LICENSE](./LICENSE).
