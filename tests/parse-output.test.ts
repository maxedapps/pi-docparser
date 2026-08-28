import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  boundedLevenshtein,
  matchPageTextItems,
  normalizeSearchString,
  projectPage,
  streamParseOutput,
  writeParseOutputFile,
} from "../extensions/docparser/parse-output.mjs";

function sampleResult() {
  return {
    pages: [
      {
        pageNum: 1,
        width: 612,
        height: 792,
        text: "control:\u0000\n pair:😀 lone:\ud800 end",
        markdown: "upstream-only",
        textItems: [
          {
            text: 'quote:" slash:\\ tabs:\t 😀 \udc00',
            x: 1.25,
            y: 2,
            width: 3,
            height: 4,
            fontName: "Example",
            fontSize: 12,
            confidence: 0.9,
            fontHeight: 99,
            words: [{ text: "ignored" }],
            bytes: Buffer.from("ignored"),
          },
          {
            text: "optional-invalid",
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            fontName: 10,
            fontSize: Number.NaN,
            confidence: Number.POSITIVE_INFINITY,
          },
        ],
      },
    ],
    text: "aggregate 😀 \ud800 \u0001",
    images: [Buffer.alloc(100)],
    metadata: { ignored: true },
  };
}

async function streamToBuffer(result: unknown, format: "text" | "json", maximum = 1024 * 1024) {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const metadata = await streamParseOutput(result, format, sink, maximum);
  sink.end();
  return { metadata, buffer: Buffer.concat(chunks) };
}

test("stable JSON projection has fixed order and exact JSON.stringify escaping", async () => {
  const source = sampleResult();
  const reference = {
    pages: source.pages.map((page, index) => projectPage(page, index)),
    text: source.text,
  };
  const expected = JSON.stringify(reference);
  const { metadata, buffer } = await streamToBuffer(source, "json");
  assert.equal(buffer.toString("utf8"), expected);
  assert.equal(metadata.bytes, Buffer.byteLength(expected));
  assert.equal(metadata.pageCount, 1);
  assert.deepEqual(JSON.parse(buffer.toString("utf8")), reference);
  assert.equal(buffer.includes(Buffer.from("markdown")), false);
  assert.equal(buffer.includes(Buffer.from("fontHeight")), false);
  assert.equal(buffer.includes(Buffer.from("images")), false);
  assert.match(buffer.toString("utf8"), /\\ud800/);
  assert.match(buffer.toString("utf8"), /\\udc00/);
  assert.equal(buffer.toString("utf8").includes("😀"), true);
});

test("required non-finite values reject while invalid optional values are omitted", async () => {
  const source = sampleResult();
  const projected = projectPage(source.pages[0]);
  assert.deepEqual(projected.textItems[1], {
    text: "optional-invalid",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  for (const field of ["pageNum", "width", "height"] as const) {
    const page = { ...source.pages[0], [field]: Number.NaN };
    await assert.rejects(streamToBuffer({ pages: [page], text: "" }, "json"), /must be finite/);
  }
  const invalidItem = { ...source.pages[0].textItems[0], x: Number.POSITIVE_INFINITY };
  await assert.rejects(
    streamToBuffer({ pages: [{ ...source.pages[0], textItems: [invalidItem] }], text: "" }, "json"),
    /must be finite/,
  );
});

test("byte accounting includes compact syntax and escaped UTF-8 bytes exactly", async () => {
  const source = sampleResult();
  const reference = JSON.stringify({
    pages: source.pages.map((page, index) => projectPage(page, index)),
    text: source.text,
  });
  const exactBytes = Buffer.byteLength(reference, "utf8");
  const exact = await streamToBuffer(source, "json", exactBytes);
  assert.equal(exact.metadata.bytes, exactBytes);
  await assert.rejects(streamToBuffer(source, "json", exactBytes - 1), /exceeds/);
});

test("text output is chunked without corrupting surrogate pairs and obeys its budget", async () => {
  const text = `${"x".repeat(16 * 1024 - 1)}😀${"y".repeat(20_000)}\ud800`;
  const source = { pages: [], text };
  const expected = Buffer.from(text, "utf8");
  const output = await streamToBuffer(source, "text", expected.byteLength);
  assert.deepEqual(output.buffer, expected);
  assert.equal(output.metadata.bytes, expected.byteLength);
  await assert.rejects(streamToBuffer(source, "text", expected.byteLength - 1), /exceeds/);
});

test("partial parse files publish atomically and clean only their own partial on failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parse-output-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const partial = join(directory, "parsed.partial");
  const output = join(directory, "parsed.json");
  const source = sampleResult();
  const metadata = await writeParseOutputFile(source, "json", partial, output);
  assert.equal((await readFile(output)).byteLength, metadata.bytes);
  await assert.rejects(readFile(partial), /ENOENT/);

  const failedPartial = join(directory, "failed.partial");
  const failedOutput = join(directory, "failed.json");
  await assert.rejects(
    writeParseOutputFile(source, "json", failedPartial, failedOutput, 10),
    /exceeds/,
  );
  await assert.rejects(readFile(failedPartial), /ENOENT/);
  await assert.rejects(readFile(failedOutput), /ENOENT/);
  assert.equal((await readFile(output)).byteLength, metadata.bytes);
});

test("normalizeSearchString removes diacritics and collapses punctuation/whitespace", () => {
  assert.equal(normalizeSearchString("Café  au\tlait!"), "cafe au lait");
  assert.equal(normalizeSearchString("fodhelper.exe,269"), "fodhelper exe 269");
  assert.equal(normalizeSearchString("SyncBreeze—Server"), "syncbreeze server");
});

test("boundedLevenshtein respects maxCost and computes distance", () => {
  assert.equal(boundedLevenshtein("fodhelper", "fodhelper", 2), 0);
  assert.equal(boundedLevenshtein("fodhelper", "fodhelpr", 2), 1);
  assert.equal(boundedLevenshtein("fodhelper", "fodhxxypr", 2), 3);
});

test("matchPageTextItems handles exact, normalized, multi-line, and fuzzy hits", () => {
  const items = [
    { text: "7.1.3 Bypassing UAC", x: 10, y: 20, width: 100, height: 15 },
    {
      text: "Our UAC bypass is chiefly based on fodhelper.exe,269 a Microsoft support",
      x: 10,
      y: 40,
      width: 200,
      height: 15,
    },
    {
      text: "application responsible for managing language changes.",
      x: 10,
      y: 60,
      width: 200,
      height: 15,
    },
  ];

  // Exact substring
  const exact = matchPageTextItems(items, { phrase: "fodhelper.exe" });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].text, items[1].text);

  // Case-insensitive & normalized whitespace/punctuation
  const norm = matchPageTextItems(items, { phrase: "fodhelper exe 269" });
  assert.equal(norm.length, 1);

  // Multi-line span
  const multi = matchPageTextItems(items, { phrase: "Microsoft support application responsible" });
  assert.equal(multi.length, 1);
  assert.equal(multi[0].y, 40);
  assert.equal(multi[0].height, 35); // 60 + 15 - 40 = 35

  // Minor typo / fuzzy match
  const fuzzy = matchPageTextItems(items, { phrase: "fodhelpr" });
  assert.equal(fuzzy.length, 1);

  // Unrelated query returns 0 hits
  const unrelated = matchPageTextItems(items, { phrase: "nonexistent query xyz" });
  assert.equal(unrelated.length, 0);
});
