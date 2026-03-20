# Third-Party Notices

## LiteParse

This package depends on the following third-party library at runtime:

- **Package:** `@llamaindex/liteparse`
- **Version used by this package:** `1.0.0`
- **Repository:** https://github.com/run-llama/liteparse
- **License:** Apache-2.0
- **Local license copy:** [`./licenses/LiteParse-APACHE-2.0.txt`](./licenses/LiteParse-APACHE-2.0.txt)
- **Upstream license file:** https://github.com/run-llama/liteparse/blob/main/LICENSE

### Usage in this package

`pi-docparser` uses LiteParse as an npm dependency to provide:

- local document parsing
- OCR support
- PDF screenshot generation
- conversion support for Office and image inputs

This package does **not** vendor LiteParse source code.
It relies on the installed npm dependency at runtime.

### Upstream attribution

LiteParse is developed by LlamaIndex and distributed under the Apache License 2.0.
Please review the upstream repository and license for full details.
