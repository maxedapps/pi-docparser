import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_DPI,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULTS,
  MAX_DPI,
  MAX_NUM_WORKERS,
  MAX_PAGES,
  MAX_PAGE_SELECTION_BYTES,
  MAX_RESULTS,
  MAX_SCREENSHOT_PAGES,
  MAX_SEARCH_PHRASE_BYTES,
  MIN_DPI,
} from "../extensions/docparser/constants.ts";

import {
  NativeCancellationError,
  NativeCrashError,
  NativeTimeoutError,
  createNativeExecutor,
} from "../extensions/docparser/native-executor.ts";
import { registerDocumentSearchTool } from "../extensions/docparser/search-tool.ts";
import { registerDocumentScreenshotTool } from "../extensions/docparser/screenshot-tool.ts";
import { registerDocumentParseTool } from "../extensions/docparser/tool.ts";
import type {
  NativeExecuteOptions,
  NativeExecutor,
  NativeJob,
  NativeParseJob,
  NativeParseResult,
  NativeScreenshotJob,
  NativeScreenshotResult,
  NativeSearchJob,
  NativeSearchResult,
} from "../extensions/docparser/types.ts";

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: ToolDeclaration;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: string;
  execute: (...args: any[]) => Promise<any>;
};

type DeclarationProperty = {
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  description?: string;
};

type ToolDeclaration = {
  required?: string[];
  properties: Record<string, DeclarationProperty>;
};

function declarationOf(tool: RegisteredTool): { bytes: number; schema: ToolDeclaration } {
  assert.ok(tool.parameters, `${tool.name} must declare parameters`);
  const bytes = Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    "utf8",
  );
  return { bytes, schema: tool.parameters };
}

function bounds(property: DeclarationProperty | undefined) {
  assert.ok(property, "expected schema property");
  return { minimum: property.minimum, maximum: property.maximum };
}

class FakeExecutor implements NativeExecutor {
  calls: Array<{ job: NativeJob; options?: NativeExecuteOptions }> = [];
  failure?: Error;
  screenshotFailure?: Error;
  searchResult?: NativeSearchResult;
  screenshotFiles: Buffer[] = [Buffer.from("png")];
  waitForAbort = false;

  execute(job: NativeParseJob, options?: NativeExecuteOptions): Promise<NativeParseResult>;
  execute(job: NativeSearchJob, options?: NativeExecuteOptions): Promise<NativeSearchResult>;
  execute(
    job: NativeScreenshotJob,
    options?: NativeExecuteOptions,
  ): Promise<NativeScreenshotResult>;
  async execute(
    job: NativeJob,
    options?: NativeExecuteOptions,
  ): Promise<NativeParseResult | NativeSearchResult | NativeScreenshotResult> {
    this.calls.push({ job, options });
    if (this.waitForAbort) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new NativeCancellationError();
    }
    if (this.failure) throw this.failure;
    if (job.operation === "parse") {
      await writeFile(job.outputPath, `${"preview line\n".repeat(30)}${"x".repeat(3_000)}`);
      return {
        pageCount: 2,
        outputBytes: (await readFile(job.outputPath)).byteLength,
        outputPath: job.outputPath,
      };
    }
    if (job.operation === "search") {
      return (
        this.searchResult ?? {
          pageCount: 1,
          hits: [],
          truncatedByCount: false,
          truncatedByBytes: false,
        }
      );
    }
    if (this.screenshotFailure) throw this.screenshotFailure;
    await mkdir(job.outputDir, { recursive: true });
    const screenshots = [];
    let totalBytes = 0;
    for (let index = 0; index < job.pages.length; index += 1) {
      const data = this.screenshotFiles[index] ?? Buffer.from("png");
      const outputPath = join(job.outputDir, `page_${job.pages[index]}.png`);
      await writeFile(outputPath, data);
      totalBytes += data.byteLength;
      screenshots.push({
        pageNum: job.pages[index],
        width: 100,
        height: 100,
        outputPath,
        bytes: data.byteLength,
      });
    }
    return { screenshotDir: job.outputDir, screenshots, totalBytes };
  }

  async dispose(): Promise<void> {}
}

function captureTools(executor: NativeExecutor): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  registerDocumentParseTool(pi, executor);
  registerDocumentSearchTool(pi, executor);
  registerDocumentScreenshotTool(pi, executor);
  return tools;
}

function execute(tool: RegisteredTool, params: Record<string, unknown>, signal?: AbortSignal) {
  return tool.execute("call", params, signal, undefined, { cwd: process.cwd() });
}

async function waitForCalls(fake: FakeExecutor, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (fake.calls.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fake.calls.length, count);
}

test("all tools use one injected executor, pass signals, and leave executionMode unset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-shared-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  const tools = captureTools(fake);
  const signal = new AbortController().signal;
  await execute(tools.get("document_parse")!, { path: input }, signal);
  await execute(tools.get("document_search")!, { path: input, phrase: "hello" }, signal);
  await execute(tools.get("document_screenshot")!, { path: input }, signal);
  assert.deepEqual(
    fake.calls.map((call) => call.job.operation),
    ["parse", "search", "screenshot"],
  );
  assert.ok(fake.calls.every((call) => call.options?.signal === signal));
  assert.ok([...tools.values()].every((tool) => !("executionMode" in tool)));
});

test("concurrent cross-kind tool calls share the native executor's single FIFO", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-concurrent-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  const logPath = join(directory, "events.log");
  await writeFile(input, JSON.stringify({ logPath, logOperation: true, delay: 80 }));
  const executor = createNativeExecutor({
    workerUrl: new URL("./helpers/fake-native-worker.mjs", import.meta.url),
    timeoutMs: 5_000,
  });
  t.after(() => executor.dispose());
  const tools = captureTools(executor);

  const [parsed, searched, screenshots] = await Promise.all([
    execute(tools.get("document_parse")!, { path: input }),
    execute(tools.get("document_search")!, { path: input, phrase: "hello" }),
    execute(tools.get("document_screenshot")!, { path: input }),
  ]);
  t.after(() => rm(parsed.details.outputDir, { recursive: true, force: true }));
  t.after(() => rm(screenshots.details.outputDir, { recursive: true, force: true }));
  assert.equal(searched.details.hits.length, 0);
  const events = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.deepEqual(
    events
      .filter((_, index) => index % 2 === 0)
      .map((event) => event.slice("start:".length))
      .sort(),
    ["parse", "screenshot", "search"],
  );
  for (let index = 0; index < events.length; index += 2) {
    assert.equal(events[index].replace("start:", ""), events[index + 1].replace("end:", ""));
  }
});

test("parse reads a bounded preview and isolates optional screenshot failure as a warning", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-parse-warning-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.screenshotFailure = new NativeCrashError("segmentation fault");
  const result = await execute(captureTools(fake).get("document_parse")!, {
    path: input,
    screenshotPages: "1",
  });
  assert.equal(fake.calls.length, 2);
  assert.notEqual(fake.calls[0].job.stagingDir, fake.calls[1].job.stagingDir);
  assert.match(result.content[0].text, /Preview truncated/);
  assert.match(result.content[0].text, /worker crashed/i);
  assert.equal(result.details.pageCount, 2);
  assert.equal(result.details.screenshotCount, 0);
  assert.equal(
    (await readFile(result.details.outputPath, "utf8")).startsWith("preview line"),
    true,
  );
});

test("search exposes bounded projected hits and explicit worker truncation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-search-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.searchResult = {
    pageCount: 1,
    hits: Array.from({ length: 200 }, (_, index) => ({
      pageNum: 1,
      text: `hit ${index} ${"x".repeat(30)}`,
      x: index,
      y: 0,
      width: 1,
      height: 1,
    })),
    truncatedByCount: true,
    truncatedByBytes: true,
  };
  const result = await execute(captureTools(fake).get("document_search")!, {
    path: input,
    phrase: "hit",
    maxResults: 200,
  });
  assert.equal(result.details.hits.length, 200);
  assert.equal(result.details.truncatedByCount, true);
  assert.equal(result.details.truncatedByBytes, true);
  assert.equal(result.details.previewTruncated, true);
  assert.match(result.content[0].text, /result limit/);
  assert.match(result.content[0].text, /response byte limit/);
  assert.ok(Buffer.byteLength(result.content[0].text) < 4_096);
});

test("screenshots inline only small PNGs and retain paths plus warnings for omitted files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-screenshot-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.screenshotFiles = [Buffer.from("small"), Buffer.alloc(3 * 1024 * 1024 + 1)];
  const result = await execute(captureTools(fake).get("document_screenshot")!, {
    path: input,
    pages: "1,2",
  });
  assert.equal(result.content.filter((item: { type: string }) => item.type === "image").length, 1);
  assert.equal(result.details.screenshots.length, 2);
  assert.equal(result.details.warnings.length, 1);
  assert.match(result.content[0].text, /was not inlined/);
  assert.match(result.content[0].text, /page_2\.png/);
});

test("active cancellation stays classified and removes the failed parse temp directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-active-cancellation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.waitForAbort = true;
  const controller = new AbortController();
  const pending = execute(
    captureTools(fake).get("document_parse")!,
    { path: input },
    controller.signal,
  );
  await waitForCalls(fake, 1);
  const outputDir = dirname((fake.calls[0].job as NativeParseJob).outputPath);
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

test("failed screenshot execution removes its tool-owned temp directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-failed-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const fake = new FakeExecutor();
  fake.screenshotFailure = new NativeCrashError("fake crash");
  await assert.rejects(
    execute(captureTools(fake).get("document_screenshot")!, { path: input }),
    /worker crashed/i,
  );
  const screenshotJob = fake.calls[0].job as NativeScreenshotJob;
  await assert.rejects(stat(dirname(screenshotJob.outputDir)), /ENOENT/);
});

test("pre-start cancellation is stable and native timeout/crash categories remain distinct", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-error-categories-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.pdf");
  await writeFile(input, "%PDF-1.4\n");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await execute(
    captureTools(new FakeExecutor()).get("document_parse")!,
    { path: input },
    controller.signal,
  );
  assert.match(cancelled.content[0].text, /cancelled before it started/);

  const timeout = new FakeExecutor();
  timeout.failure = new NativeTimeoutError(10);
  await assert.rejects(
    execute(captureTools(timeout).get("document_search")!, { path: input, phrase: "x" }),
    /timed out/i,
  );
  const crash = new FakeExecutor();
  crash.failure = new NativeCrashError("signal SIGSEGV");
  await assert.rejects(
    execute(captureTools(crash).get("document_screenshot")!, { path: input }),
    /worker crashed/i,
  );
});

test("tool declarations preserve fields, enums, defaults, and limits within bounded prose", () => {
  const tools = captureTools(new FakeExecutor());
  const parse = declarationOf(tools.get("document_parse")!);
  const search = declarationOf(tools.get("document_search")!);
  const screenshot = declarationOf(tools.get("document_screenshot")!);

  assert.deepEqual(Object.keys(parse.schema.properties), [
    "path",
    "format",
    "targetPages",
    "screenshotPages",
    "ocr",
    "ocrLanguage",
    "ocrLanguages",
    "ocrServerUrl",
    "numWorkers",
    "maxPages",
    "dpi",
    "preserveSmallText",
    "password",
    "tessdataPath",
  ]);
  assert.deepEqual(Object.keys(search.schema.properties), [
    "path",
    "phrase",
    "caseSensitive",
    "targetPages",
    "ocr",
    "ocrLanguage",
    "ocrLanguages",
    "ocrServerUrl",
    "numWorkers",
    "maxPages",
    "dpi",
    "password",
    "tessdataPath",
    "maxResults",
  ]);
  assert.deepEqual(Object.keys(screenshot.schema.properties), ["path", "pages", "dpi", "password"]);

  assert.deepEqual(parse.schema.required, ["path"]);
  assert.deepEqual(search.schema.required, ["path", "phrase"]);
  assert.deepEqual(screenshot.schema.required, ["path"]);

  assert.deepEqual(parse.schema.properties.format?.enum, ["text", "json"]);
  assert.deepEqual(parse.schema.properties.ocr?.enum, ["auto", "off"]);
  assert.deepEqual(search.schema.properties.ocr?.enum, ["auto", "off"]);
  assert.equal(parse.schema.properties.ocrLanguages?.minItems, 1);
  assert.equal(search.schema.properties.ocrLanguages?.minItems, 1);

  assert.deepEqual(bounds(parse.schema.properties.maxPages), { minimum: 1, maximum: MAX_PAGES });
  assert.deepEqual(bounds(parse.schema.properties.numWorkers), {
    minimum: 1,
    maximum: MAX_NUM_WORKERS,
  });
  assert.deepEqual(bounds(parse.schema.properties.dpi), { minimum: MIN_DPI, maximum: MAX_DPI });
  assert.deepEqual(bounds(search.schema.properties.maxPages), { minimum: 1, maximum: MAX_PAGES });
  assert.deepEqual(bounds(search.schema.properties.numWorkers), {
    minimum: 1,
    maximum: MAX_NUM_WORKERS,
  });
  assert.deepEqual(bounds(search.schema.properties.dpi), { minimum: MIN_DPI, maximum: MAX_DPI });
  assert.deepEqual(bounds(search.schema.properties.maxResults), {
    minimum: 1,
    maximum: MAX_RESULTS,
  });
  assert.deepEqual(bounds(screenshot.schema.properties.dpi), {
    minimum: MIN_DPI,
    maximum: MAX_DPI,
  });
  assert.equal(parse.schema.properties.targetPages?.maxLength, MAX_PAGE_SELECTION_BYTES);
  assert.equal(parse.schema.properties.screenshotPages?.maxLength, MAX_PAGE_SELECTION_BYTES);
  assert.equal(search.schema.properties.phrase?.maxLength, MAX_SEARCH_PHRASE_BYTES);
  assert.equal(search.schema.properties.targetPages?.maxLength, MAX_PAGE_SELECTION_BYTES);
  assert.equal(screenshot.schema.properties.pages?.maxLength, MAX_PAGE_SELECTION_BYTES);

  const parseDescriptions = JSON.stringify(parse.schema.properties);
  assert.match(parseDescriptions, /default: text/);
  assert.match(
    parseDescriptions,
    new RegExp(`default: ${DEFAULT_MAX_PAGES}, maximum: ${MAX_PAGES}`),
  );
  assert.match(parseDescriptions, new RegExp(`default: ${DEFAULT_DPI}`));
  assert.match(parseDescriptions, /eng, deu, fra, jpn/);
  assert.match(parseDescriptions, /\.traineddata/);
  const searchDescriptions = JSON.stringify(search.schema.properties);
  assert.match(
    searchDescriptions,
    new RegExp(`default: ${DEFAULT_MAX_RESULTS}, maximum: ${MAX_RESULTS}`),
  );
  assert.match(searchDescriptions, new RegExp(`maximum ${MAX_SEARCH_PHRASE_BYTES} UTF-8 bytes`));
  const screenshotDescriptions = JSON.stringify(screenshot.schema.properties);
  assert.match(screenshotDescriptions, /default: page 1/);
  assert.match(screenshotDescriptions, new RegExp(`maximum ${MAX_SCREENSHOT_PAGES} pages`));

  assert.match(tools.get("document_parse")?.description ?? "", /LiteParse v2/);
  assert.match(tools.get("document_parse")?.description ?? "", /PDF, DOCX, PPTX, XLSX, CSV/);
  for (const name of ["document_parse", "document_search", "document_screenshot"]) {
    const tool = tools.get(name)!;
    assert.ok(tool.promptSnippet, `${name} must keep a prompt snippet`);
    assert.equal(tool.promptGuidelines?.length, 3, `${name} must keep its prompt guidelines`);
  }

  const budgets = { document_parse: 2250, document_search: 1880, document_screenshot: 640 };
  let declaredTotal = 0;
  for (const [name, budget] of Object.entries(budgets)) {
    const declared = declarationOf(tools.get(name)!);
    declaredTotal += declared.bytes;
    assert.ok(
      declared.bytes <= budget,
      `${name} declaration is ${declared.bytes} bytes (budget ${budget})`,
    );
  }
  assert.ok(declaredTotal <= 4750, `tool declarations total ${declaredTotal} bytes`);
});
