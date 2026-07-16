import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { NativeDocumentJob, NativeDocumentResult } from "./native-protocol.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const FORCE_KILL_GRACE_MS = 250;
const MAX_STDERR_CHARS = 16_384;

export type NativeWorkerErrorKind = "crash" | "exit" | "protocol" | "timeout" | "worker";

export class NativeWorkerError extends Error {
  readonly kind: NativeWorkerErrorKind;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      kind: NativeWorkerErrorKind;
      code?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "NativeWorkerError";
    this.kind = options.kind;
    this.code = options.code ?? null;
    this.signal = options.signal ?? null;
    this.stderr = options.stderr ?? "";
  }
}

export interface NativeJobOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  workerPath?: string;
}

type WorkerResponse<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error?: { message?: string; stack?: string } };

let nativeQueueTail: Promise<void> = Promise.resolve();

function abortError(reason?: unknown): Error {
  const message = reason instanceof Error ? reason.message : "The operation was aborted";
  const error = new Error(message, { cause: reason });
  error.name = "AbortError";
  return error;
}

function resolveTimeoutMs(value: number | undefined): number {
  if (value !== undefined) return Math.max(1, Math.floor(value));
  const configured = Number(process.env.PI_DOCPARSER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TIMEOUT_MS;
}

function appendCapped(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_STDERR_CHARS) return current;
  return (current + chunk.toString()).slice(0, MAX_STDERR_CHARS);
}

function terminateWorker(child: ChildProcess): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  child.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, FORCE_KILL_GRACE_MS);
  forceKillTimer.unref();
  return forceKillTimer;
}

function executeNativeJob<TResult>(job: unknown, options: NativeJobOptions): Promise<TResult> {
  const workerPath =
    options.workerPath ??
    process.env.PI_DOCPARSER_WORKER_PATH ??
    fileURLToPath(new URL("./native-worker.mjs", import.meta.url));
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);

  return new Promise<TResult>((resolve, reject) => {
    let response: WorkerResponse<TResult> | undefined;
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = fork(workerPath, [], {
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendCapped(stderr, chunk);
    });

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      aborted = true;
      forceKillTimer = terminateWorker(child);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      forceKillTimer = terminateWorker(child);
    }, timeoutMs);
    timeoutTimer.unref();

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("spawn", () => {
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      child.send({ job });
    });

    child.on("message", (message: WorkerResponse<TResult>) => {
      response = message;
    });

    child.once("error", (cause) => {
      cleanup();
      reject(
        new NativeWorkerError(`Failed to start the isolated native worker: ${cause.message}`, {
          kind: "exit",
          stderr,
          cause,
        }),
      );
    });

    child.once("close", (code, signal) => {
      cleanup();

      if (aborted) {
        reject(abortError(options.signal?.reason));
        return;
      }
      if (timedOut) {
        reject(
          new NativeWorkerError(
            `The isolated native worker exceeded the ${timeoutMs}ms timeout and was terminated.`,
            { kind: "timeout", code, signal, stderr },
          ),
        );
        return;
      }
      if (signal) {
        reject(
          new NativeWorkerError(
            `The isolated native worker crashed with ${signal}. Pi is still running; the native parser failure was contained.`,
            { kind: "crash", code, signal, stderr },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new NativeWorkerError(
            `The isolated native worker exited with code ${code ?? "unknown"}.`,
            { kind: "exit", code, signal, stderr },
          ),
        );
        return;
      }
      if (!response) {
        reject(
          new NativeWorkerError("The isolated native worker exited without returning a result.", {
            kind: "protocol",
            code,
            signal,
            stderr,
          }),
        );
        return;
      }
      if (!response.ok) {
        const message = response.error?.message || "Native document processing failed.";
        reject(
          new NativeWorkerError(message, {
            kind: "worker",
            code,
            signal,
            stderr: [stderr, response.error?.stack].filter(Boolean).join("\n"),
          }),
        );
        return;
      }
      resolve(response.result);
    });
  });
}

/**
 * Run a native LiteParse job in a one-shot child process.
 *
 * Calls share a module-global FIFO queue. This prevents concurrent PDFium work
 * even when Pi executes multiple document tools in parallel. The child process
 * boundary also contains native SIGABRT/SIGSEGV failures so they cannot bring
 * down the Pi process.
 */
export function runNativeJob<TResult = unknown>(
  job: unknown,
  options: NativeJobOptions = {},
): Promise<TResult> {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));

  const run = async () => {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    return executeNativeJob<TResult>(job, options);
  };

  const execution = nativeQueueTail.then(run, run);
  nativeQueueTail = execution.then(
    () => undefined,
    () => undefined,
  );

  if (!options.signal) return execution;
  return new Promise<TResult>((resolve, reject) => {
    const onAbort = () => reject(abortError(options.signal?.reason));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    execution.then(
      (value) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function runNativeDocumentJob<TResult extends NativeDocumentResult>(
  job: NativeDocumentJob,
  options: NativeJobOptions = {},
): Promise<TResult> {
  return runNativeJob<TResult>(job, options);
}
