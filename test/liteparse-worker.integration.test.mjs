import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNativeJob } from "../extensions/docparser/native-runner.ts";

function makePdf(text) {
  const stream = `BT\n/F1 24 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-docparser-native-integration-"));
  const pdfPath = join(dir, "sample.pdf");
  await writeFile(pdfPath, makePdf("Hello LiteParse Worker"), "binary");
  return { dir, pdfPath };
}

const parserConfig = {
  outputFormat: "text",
  ocrEnabled: false,
  quiet: true,
};

test("isolated LiteParse worker supports parse, search, and screenshot", async () => {
  const { dir, pdfPath } = await fixture();

  const parseOutputDir = join(dir, "parse");
  const parsed = await runNativeJob({
    operation: "parse",
    filePath: pdfPath,
    parserConfig,
    outputDir: parseOutputDir,
  });
  assert.equal(parsed.pageCount, 1);
  assert.match(await readFile(parsed.outputPath, "utf8"), /Hello LiteParse Worker/);

  const searched = await runNativeJob({
    operation: "search",
    filePath: pdfPath,
    parserConfig: { ...parserConfig, outputFormat: "json" },
    phrase: "Hello LiteParse",
    caseSensitive: false,
    maxResults: 10,
  });
  assert.equal(searched.hits.length, 1);
  assert.equal(searched.hits[0].pageNum, 1);

  const screenshotDir = join(dir, "shot");
  const rendered = await runNativeJob({
    operation: "screenshot",
    filePath: pdfPath,
    parserConfig: { dpi: 72, quiet: true },
    pageNumbers: [1],
    outputDir: screenshotDir,
  });
  assert.equal(rendered.screenshots.length, 1);
  assert.ok(rendered.screenshots[0].bytes > 100);
  assert.ok(
    (await readFile(rendered.screenshots[0].outputPath)).subarray(1, 4).equals(Buffer.from("PNG")),
  );
});

test("seven simultaneous parse requests complete through the serialized worker queue", async () => {
  const { dir, pdfPath } = await fixture();
  const jobs = Array.from({ length: 7 }, (_, index) =>
    runNativeJob({
      operation: "parse",
      filePath: pdfPath,
      parserConfig,
      outputDir: join(dir, `parse-${index}`),
    }),
  );

  const results = await Promise.all(jobs);
  assert.equal(results.length, 7);
  assert.ok(results.every((result) => result.pageCount === 1));
});
