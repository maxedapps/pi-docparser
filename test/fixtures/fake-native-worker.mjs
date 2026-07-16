import { appendFileSync } from "node:fs";

function record(path, line) {
  if (path) appendFileSync(path, `${line}\n`, "utf8");
}

process.on("message", (message) => {
  const job = message?.job ?? {};
  const id = String(job.id ?? "unknown");
  record(job.logPath, `start:${id}`);

  if (job.mode === "abort" || process.env.FAKE_NATIVE_WORKER_MODE === "abort") {
    process.abort();
    return;
  }

  if (job.mode === "hang") {
    return;
  }

  if (process.env.FAKE_NATIVE_WORKER_MODE === "error") {
    process.send?.({ ok: false, error: { message: "fake isolated worker marker" } });
    process.disconnect?.();
    return;
  }

  const finish = () => {
    record(job.logPath, `end:${id}`);
    process.send?.({ ok: true, result: { id, value: job.value ?? null } });
    process.disconnect?.();
  };

  setTimeout(finish, Number(job.delayMs ?? 0));
});
