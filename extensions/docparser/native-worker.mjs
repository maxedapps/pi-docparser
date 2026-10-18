#!/usr/bin/env node
// @ts-check

import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  PROTOCOL_VERSION,
  REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  encodeFrame,
  readSingleFrame,
  validateWorkerRequest,
  writeSingleFrame,
} from "./native-protocol.mjs";
import { matchPageTextItems, projectSearchHit, writeParseOutputFile } from "./parse-output.mjs";

const PARSED_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
const SCREENSHOT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const SCREENSHOT_JOB_MAX_BYTES = 64 * 1024 * 1024;

/** @param {string} path @param {string} label */
async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists.`);
}

/** @param {Record<string, unknown>} request @returns {Partial<import("@llamaindex/liteparse").LiteParseConfig>} */
function liteParseConfig(request) {
  const config = /** @type {Record<string, unknown>} */ (request.config);
  return {
    outputFormat: /** @type {"text" | "json"} */ (config.outputFormat),
    ocrEnabled: /** @type {boolean} */ (config.ocrEnabled),
    ocrLanguage: /** @type {string | undefined} */ (config.ocrLanguage),
    ocrServerUrl: /** @type {string | undefined} */ (config.ocrServerUrl),
    numWorkers: /** @type {number} */ (config.numWorkers),
    maxPages: /** @type {number} */ (config.maxPages),
    targetPages: /** @type {string | undefined} */ (config.targetPages),
    dpi: /** @type {number} */ (config.dpi),
    preserveVerySmallText: /** @type {boolean} */ (config.preserveVerySmallText),
    password: /** @type {string | undefined} */ (config.password),
    tessdataPath: /** @type {string | undefined} */ (config.tessdataPath),
    quiet: true,
  };
}

/** @param {Record<string, unknown>} request @param {typeof import("@llamaindex/liteparse")} liteparse */
async function runParse(request, liteparse) {
  const stagingDir = /** @type {string} */ (request.stagingDir);
  const outputPath = /** @type {string} */ (request.outputPath);
  await requireAbsent(outputPath, "Parse output");
  const partialPath = join(stagingDir, `${basename(outputPath)}.partial`);
  const parser = new liteparse.LiteParse(liteParseConfig(request));
  const parseResult = await parser.parse(/** @type {string} */ (request.inputPath));
  const metadata = await writeParseOutputFile(
    parseResult,
    /** @type {"text" | "json"} */ (
      /** @type {Record<string, unknown>} */ (request.config).outputFormat
    ),
    partialPath,
    outputPath,
    PARSED_ARTIFACT_MAX_BYTES,
  );
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  return { pageCount: metadata.pageCount, outputBytes: metadata.bytes, outputPath };
}

/** @param {Record<string, unknown>} request @param {typeof import("@llamaindex/liteparse")} liteparse */
async function runSearch(request, liteparse) {
  const stagingDir = /** @type {string} */ (request.stagingDir);
  try {
    const config = liteParseConfig(request);
    let parser = new liteparse.LiteParse(config);
    let parseResult;

    // For PDF files with auto OCR (ocrEnabled true and no custom ocrServerUrl),
    // attempt fast native-text extraction first (ocrEnabled: false).
    // If sufficient text items are extracted across the parsed pages, skip heavy OCR.
    const isPdf =
      typeof request.inputPath === "string" && request.inputPath.toLowerCase().endsWith(".pdf");
    if (isPdf && config.ocrEnabled && !config.ocrServerUrl) {
      const fastParser = new liteparse.LiteParse({ ...config, ocrEnabled: false });
      const fastResult = await fastParser.parse(/** @type {string} */ (request.inputPath));
      const totalItems = fastResult.pages.reduce(
        (acc, p) => acc + (p.textItems ? p.textItems.length : 0),
        0,
      );
      if (totalItems > 0 || fastResult.pages.length === 0) {
        parseResult = fastResult;
      } else {
        parseResult = await parser.parse(/** @type {string} */ (request.inputPath));
      }
    } else {
      parseResult = await parser.parse(/** @type {string} */ (request.inputPath));
    }

    /** @type {Array<Record<string, string | number>>} */
    const hits = [];
    let truncatedByCount = false;
    let truncatedByBytes = false;
    const maxResults = /** @type {number} */ (request.maxResults);

    outer: for (const page of parseResult.pages) {
      /** @type {any[]} */
      let pageHits = [];
      if (Array.isArray(page.textItems)) {
        try {
          pageHits = liteparse.searchItems(page.textItems, {
            phrase: /** @type {string} */ (request.phrase),
            caseSensitive: /** @type {boolean} */ (request.caseSensitive),
          });
        } catch {
          pageHits = [];
        }
      }
      if (pageHits.length === 0) {
        pageHits = matchPageTextItems(page.textItems, {
          phrase: /** @type {string} */ (request.phrase),
          caseSensitive: /** @type {boolean} */ (request.caseSensitive),
        });
      }
      for (let index = 0; index < pageHits.length; index += 1) {
        if (hits.length >= maxResults) {
          truncatedByCount = true;
          break outer;
        }
        const hit = projectSearchHit(pageHits[index], page.pageNum, `search hit ${hits.length}`);
        const candidate = [...hits, hit];
        const envelope = {
          version: PROTOCOL_VERSION,
          operation: "search",
          jobId: request.jobId,
          ok: true,
          result: {
            pageCount: parseResult.pages.length,
            hits: candidate,
            truncatedByCount: false,
            truncatedByBytes: false,
          },
        };
        try {
          encodeFrame(envelope, RESPONSE_MAX_BYTES, "Search response");
        } catch {
          truncatedByBytes = true;
          break outer;
        }
        hits.push(hit);
      }
    }

    return { pageCount: parseResult.pages.length, hits, truncatedByCount, truncatedByBytes };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** @param {Record<string, unknown>} request @param {typeof import("@llamaindex/liteparse")} liteparse */
async function runScreenshot(request, liteparse) {
  const stagingDir = /** @type {string} */ (request.stagingDir);
  const outputDir = /** @type {string} */ (request.outputDir);
  await requireAbsent(outputDir, "Screenshot output directory");
  const partialDir = join(stagingDir, "screenshots.partial");
  await mkdir(partialDir);
  const parser = new liteparse.LiteParse({
    dpi: /** @type {number} */ (request.dpi),
    password: /** @type {string | undefined} */ (request.password),
    quiet: true,
  });
  /** @type {Array<{pageNum: number, width: number, height: number, outputPath: string, bytes: number}>} */
  const screenshots = [];
  let totalBytes = 0;

  for (const requestedPage of /** @type {number[]} */ (request.pages)) {
    const rendered = await parser.screenshot(/** @type {string} */ (request.inputPath), [
      requestedPage,
    ]);
    if (rendered.length !== 1 || rendered[0].pageNum !== requestedPage) {
      throw new Error(
        `Screenshot generation returned an unexpected result for page ${requestedPage}.`,
      );
    }
    const screenshot = rendered[0];
    if (
      !Buffer.isBuffer(screenshot.imageBuffer) ||
      !screenshot.imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error(`Screenshot page ${requestedPage} did not return a PNG buffer.`);
    if (!Number.isFinite(screenshot.width) || !Number.isFinite(screenshot.height))
      throw new Error(`Screenshot page ${requestedPage} returned invalid dimensions.`);
    const bytes = screenshot.imageBuffer.byteLength;
    if (bytes > SCREENSHOT_FILE_MAX_BYTES)
      throw new Error(
        `Screenshot page ${requestedPage} exceeds the ${SCREENSHOT_FILE_MAX_BYTES}-byte file limit.`,
      );
    if (totalBytes + bytes > SCREENSHOT_JOB_MAX_BYTES)
      throw new Error(
        `Screenshot job exceeds the ${SCREENSHOT_JOB_MAX_BYTES}-byte aggregate limit.`,
      );
    totalBytes += bytes;
    const filename = `page_${requestedPage}.png`;
    const partialPath = join(partialDir, `${filename}.partial`);
    const temporaryPath = join(partialDir, filename);
    await writeFile(partialPath, screenshot.imageBuffer, { flag: "wx" });
    const fileStats = await stat(partialPath);
    if (fileStats.size !== bytes)
      throw new Error(`Screenshot page ${requestedPage} was not written completely.`);
    await rename(partialPath, temporaryPath);
    screenshots.push({
      pageNum: requestedPage,
      width: screenshot.width,
      height: screenshot.height,
      outputPath: join(outputDir, filename),
      bytes,
    });
  }

  await rename(partialDir, outputDir);
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  return { screenshotDir: outputDir, screenshots, totalBytes };
}

/** @param {Record<string, unknown>} request */
async function runOperation(request) {
  const inputStats = await stat(/** @type {string} */ (request.inputPath));
  if (!inputStats.isFile()) throw new Error("Worker input path is not a regular file.");
  const liteparse = await import("@llamaindex/liteparse");
  if (request.operation === "parse") return runParse(request, liteparse);
  if (request.operation === "search") return runSearch(request, liteparse);
  return runScreenshot(request, liteparse);
}

const requestStream = createReadStream("", { fd: 3, autoClose: false });
const responseStream = createWriteStream("", { fd: 4, autoClose: false });
let request;
try {
  request = /** @type {Record<string, unknown>} */ (
    validateWorkerRequest(await readSingleFrame(requestStream, REQUEST_MAX_BYTES, "Request"))
  );
} catch (error) {
  process.stderr.write(
    `Invalid native worker request: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

if (request) {
  let response;
  let ownsStaging = false;
  try {
    const owner = await readFile(
      join(/** @type {string} */ (request.stagingDir), ".native-job-owner"),
      "utf8",
    );
    if (owner !== request.jobId) throw new Error("Native job staging ownership marker mismatch.");
    ownsStaging = true;
    const result = await runOperation(request);
    response = {
      version: PROTOCOL_VERSION,
      operation: request.operation,
      jobId: request.jobId,
      ok: true,
      result,
    };
  } catch (error) {
    if (ownsStaging) {
      await rm(/** @type {string} */ (request.stagingDir), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    response = {
      version: PROTOCOL_VERSION,
      operation: request.operation,
      jobId: request.jobId,
      ok: false,
      error: {
        kind: "ordinary",
        message: (rawMessage || "Native document operation failed.").slice(0, 16 * 1024),
      },
    };
  }
  try {
    await writeSingleFrame(responseStream, response, RESPONSE_MAX_BYTES, "Response");
  } catch (error) {
    process.stderr.write(
      `Failed to write native worker response: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
