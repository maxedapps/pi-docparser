import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

async function parseDocument(job, LiteParse) {
  const parser = new LiteParse(job.parserConfig ?? {});
  const result = await parser.parse(job.filePath);
  const outputFormat = job.parserConfig?.outputFormat === "json" ? "json" : "text";
  const outputText = outputFormat === "json" ? JSON.stringify(result, null, 2) : result.text;
  await mkdir(job.outputDir, { recursive: true });
  const outputPath = join(job.outputDir, outputFormat === "json" ? "parsed.json" : "parsed.txt");
  await writeFile(outputPath, outputText, "utf8");
  return { outputFormat, outputPath, pageCount: result.pages.length };
}

async function searchDocument(job, LiteParse, searchItems) {
  const parser = new LiteParse(job.parserConfig ?? {});
  const result = await parser.parse(job.filePath);
  const hits = [];

  for (const page of result.pages) {
    const pageHits = searchItems(page.textItems, {
      phrase: job.phrase,
      caseSensitive: job.caseSensitive ?? false,
    });
    for (const hit of pageHits) {
      hits.push({ ...hit, pageNum: page.pageNum });
      if (hits.length >= job.maxResults) return { hits };
    }
  }
  return { hits };
}

async function screenshotDocument(job, LiteParse) {
  const parser = new LiteParse(job.parserConfig ?? {});
  const screenshots = await parser.screenshot(job.filePath, job.pageNumbers);
  const screenshotDir = join(job.outputDir, "screenshots");
  await mkdir(screenshotDir, { recursive: true });
  const artifacts = [];

  for (const screenshot of screenshots) {
    const outputPath = join(screenshotDir, `page_${screenshot.pageNum}.png`);
    await writeFile(outputPath, screenshot.imageBuffer);
    artifacts.push({
      pageNum: screenshot.pageNum,
      width: screenshot.width,
      height: screenshot.height,
      outputPath,
      bytes: screenshot.imageBuffer.byteLength,
    });
  }
  return { screenshotDir, screenshots: artifacts };
}

async function run(job) {
  const { LiteParse, searchItems } = await import("@llamaindex/liteparse");
  switch (job?.operation) {
    case "parse":
      return parseDocument(job, LiteParse);
    case "search":
      return searchDocument(job, LiteParse, searchItems);
    case "screenshot":
      return screenshotDocument(job, LiteParse);
    default:
      throw new Error(`Unknown native document operation: ${String(job?.operation)}`);
  }
}

function reply(message) {
  if (!process.send) {
    process.exitCode = 1;
    return;
  }
  process.send(message, () => process.exit(0));
}

process.once("message", async (message) => {
  try {
    reply({ ok: true, result: await run(message?.job) });
  } catch (error) {
    reply({ ok: false, error: serializeError(error) });
  }
});
