import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import parseDocumentExtension from "../extensions/docparser/index.ts";

function makePdf() {
  const stream = "BT\n/F1 18 Tf\n72 720 Td\n(Isolated tool test) Tj\nET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

function registerTools() {
  const tools = [];
  const pi = {
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand() {},
  };
  parseDocumentExtension(pi);
  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("public document tools preserve successful parse, search, and screenshot results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-docparser-tool-success-"));
  const pdfPath = join(dir, "sample.pdf");
  await writeFile(pdfPath, makePdf(), "binary");
  const tools = registerTools();

  const parseResult = await tools
    .get("document_parse")
    .execute("test-parse", { path: pdfPath, ocr: "off" }, undefined, undefined, { cwd: dir });
  assert.equal(parseResult.details.pageCount, 1);
  assert.match(await readFile(parseResult.details.outputPath, "utf8"), /Isolated tool test/);

  const searchResult = await tools
    .get("document_search")
    .execute(
      "test-search",
      { path: pdfPath, phrase: "Isolated", ocr: "off" },
      undefined,
      undefined,
      { cwd: dir },
    );
  assert.ok(searchResult.details.hits.length >= 1);
  assert.equal(searchResult.details.hits[0].pageNum, 1);

  const screenshotResult = await tools
    .get("document_screenshot")
    .execute("test-screenshot", { path: pdfPath, pages: "1", dpi: 72 }, undefined, undefined, {
      cwd: dir,
    });
  assert.equal(screenshotResult.details.screenshots.length, 1);
  assert.ok(screenshotResult.content.some((item) => item.type === "image" && item.data.length > 0));
});

test("all public document tools route through the isolated worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-docparser-tool-isolation-"));
  const pdfPath = join(dir, "sample.pdf");
  await writeFile(pdfPath, makePdf(), "binary");
  const workerPath = fileURLToPath(new URL("./fixtures/fake-native-worker.mjs", import.meta.url));
  const previousWorker = process.env.PI_DOCPARSER_WORKER_PATH;
  const previousMode = process.env.FAKE_NATIVE_WORKER_MODE;
  process.env.PI_DOCPARSER_WORKER_PATH = workerPath;
  process.env.FAKE_NATIVE_WORKER_MODE = "error";

  try {
    const tools = registerTools();
    const cases = [
      ["document_parse", { path: pdfPath, ocr: "off" }],
      ["document_search", { path: pdfPath, phrase: "Isolated", ocr: "off" }],
      ["document_screenshot", { path: pdfPath, pages: "1", dpi: 72 }],
    ];

    for (const [name, params] of cases) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} was not registered`);
      await assert.rejects(
        tool.execute(`test-${name}`, params, undefined, undefined, { cwd: dir }),
        /fake isolated worker marker/i,
      );
    }
  } finally {
    if (previousWorker === undefined) delete process.env.PI_DOCPARSER_WORKER_PATH;
    else process.env.PI_DOCPARSER_WORKER_PATH = previousWorker;
    if (previousMode === undefined) delete process.env.FAKE_NATIVE_WORKER_MODE;
    else process.env.FAKE_NATIVE_WORKER_MODE = previousMode;
  }
});
