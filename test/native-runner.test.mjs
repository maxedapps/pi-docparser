import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NativeWorkerError, runNativeJob } from "../extensions/docparser/native-runner.ts";

const workerPath = fileURLToPath(new URL("./fixtures/fake-native-worker.mjs", import.meta.url));

function options(overrides = {}) {
  return { workerPath, timeoutMs: 2_000, ...overrides };
}

test("native jobs are serialized in FIFO order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-docparser-queue-test-"));
  const logPath = join(dir, "events.log");

  const results = await Promise.all([
    runNativeJob({ id: "one", mode: "success", delayMs: 60, logPath }, options()),
    runNativeJob({ id: "two", mode: "success", delayMs: 20, logPath }, options()),
    runNativeJob({ id: "three", mode: "success", delayMs: 1, logPath }, options()),
  ]);

  assert.deepEqual(
    results.map((result) => result.id),
    ["one", "two", "three"],
  );
  assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n"), [
    "start:one",
    "end:one",
    "start:two",
    "end:two",
    "start:three",
    "end:three",
  ]);
});

test("SIGABRT is isolated and the queue recovers for the next job", async () => {
  await assert.rejects(runNativeJob({ id: "crash", mode: "abort" }, options()), (error) => {
    assert.ok(error instanceof NativeWorkerError);
    if (process.platform === "win32") {
      assert.ok(["crash", "exit"].includes(error.kind));
    } else {
      assert.equal(error.kind, "crash");
      assert.equal(error.signal, "SIGABRT");
    }
    assert.match(error.message, /isolated native worker/i);
    return true;
  });

  const result = await runNativeJob(
    { id: "after-crash", mode: "success", value: "alive" },
    options(),
  );
  assert.deepEqual(result, { id: "after-crash", value: "alive" });
});

test("a timed-out native job is terminated without blocking later jobs", async () => {
  await assert.rejects(
    runNativeJob({ id: "hang", mode: "hang" }, options({ timeoutMs: 50 })),
    (error) => {
      assert.ok(error instanceof NativeWorkerError);
      assert.equal(error.kind, "timeout");
      return true;
    },
  );

  const result = await runNativeJob({ id: "after-timeout", mode: "success" }, options());
  assert.equal(result.id, "after-timeout");
});

test("an aborted queued job never starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-docparser-abort-queue-test-"));
  const logPath = join(dir, "events.log");
  let firstFinished = false;
  const first = runNativeJob(
    { id: "blocking", mode: "success", delayMs: 100, logPath },
    options(),
  ).finally(() => {
    firstFinished = true;
  });
  const controller = new AbortController();
  const queued = runNativeJob(
    { id: "cancelled", mode: "success", logPath },
    options({ signal: controller.signal }),
  );
  controller.abort();

  await assert.rejects(queued, (error) => error?.name === "AbortError");
  assert.equal(firstFinished, false, "queued cancellation should reject immediately");
  await first;
  assert.deepEqual((await readFile(logPath, "utf8")).trim().split("\n"), [
    "start:blocking",
    "end:blocking",
  ]);
});

test("an in-flight abort terminates the worker and releases the queue", async () => {
  const controller = new AbortController();
  const running = runNativeJob(
    { id: "running", mode: "success", delayMs: 1_000 },
    options({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 40);

  await assert.rejects(running, (error) => error?.name === "AbortError");
  const result = await runNativeJob({ id: "after-abort", mode: "success" }, options());
  assert.equal(result.id, "after-abort");
});
