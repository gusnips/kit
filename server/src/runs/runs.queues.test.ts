import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Queue, Worker } from "bullmq";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually } from "../__tests__/eventually.ts";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { hasRedisServer, startRedisServer } from "../__tests__/redis-server.ts";
import { createQueue, createWorker, removeLeftoverJob } from "../bullmq/index.ts";
import { createRedis } from "../redis/index.ts";
import { createRuns, type DriveOutcome, type Run } from "./index.ts";

const TABLE_SQL = /```sql\n(CREATE TABLE app\.runs[\s\S]*?)```/.exec(
  readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
)?.[1];

const source = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

// The worker that gets killed: the README's BullMQ recipe in its own process, with a handler that
// saves a checkpoint, emits one event, says so, and never returns. Every worker on the queue gets
// the short stall check: one check skips the queue for its own interval, so a single worker on the
// 30-second default holds every other worker's check back that long.
const WORKER = join(mkdtempSync(join(tmpdir(), "serverkit-runs-")), "worker.mjs");
writeFileSync(
  WORKER,
  `import { createRuns } from ${source("./index.ts")};
import { createWorker } from ${source("../bullmq/index.ts")};
import { createPgPool } from ${source("../pg/index.ts")};
import { createRedis } from ${source("../redis/index.ts")};
const [redisUrl, pgUrl] = process.argv.slice(2);
const fail = (error) => { console.error(error); process.exit(1); };
const pool = createPgPool({ connectionString: pgUrl, onIdleError: fail });
const runs = createRuns(pool, { table: "app.runs", events: "app.run_events", onError: fail, leaseSecs: 1 });
const connection = createRedis({ url: redisUrl, onError: fail });
createWorker("runs", (job) => runs.drive(job.data.runId, {
  report: async (run) => {
    await run.save({ step: 1 });
    run.emit("step", { n: 1 });
    console.log("ready");
    return new Promise(() => {});
  },
}), { connection, onError: fail, lockDuration: 2_000, stalledInterval: 1_000 });
`,
);

describe.skipIf(!hasPostgres || !hasRedisServer)("runs on a BullMQ queue", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let redisServer: Awaited<ReturnType<typeof startRedisServer>>;
  let pool: Pool;
  let redis: ReturnType<typeof createRedis>;
  let queue: Queue<{ runId: string }>;
  let worker: Worker<{ runId: string }> | undefined;
  const errors: unknown[] = [];

  beforeAll(async () => {
    [postgres, redisServer] = await Promise.all([startPostgres(), startRedisServer()]);
    pool = new Pool({ connectionString: postgres.url });
    await pool.query("CREATE SCHEMA app");
    if (!TABLE_SQL) throw new Error("The README's CREATE TABLE for app.runs is gone");
    await pool.query(TABLE_SQL);
    redis = createRedis({ url: redisServer.url, onError: (error) => void errors.push(error) });
    queue = createQueue("runs", {
      connection: redis,
      onError: (error) => void errors.push(error),
      defaultJobOptions: { attempts: 1 },
    });
  }, 60_000);

  afterAll(async () => {
    await worker?.close(true);
    await queue.close();
    redis.disconnect();
    redisServer.stop();
    await pool.end();
    await postgres.stop();
  });

  it("resumes a run from its checkpoint after its worker process is killed, and runs it once", async () => {
    const runs = createRuns(pool, {
      table: "app.runs",
      events: "app.run_events",
      onError: (error) => void errors.push(error),
      leaseSecs: 1,
    });
    const { id } = await runs.create({
      kind: "report",
      owner: "user-1",
      input: { topic: "rivers" },
      restart: "resume",
    });
    await queue.add("run", { runId: id }, { jobId: id });

    const child = spawn(process.execPath, [WORKER, redisServer.url, postgres.url], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
      child.once("exit", () => reject(new Error("The worker process exited before its run began")));
    });
    // emit does not wait for its write, so the kill waits for it.
    await eventually(
      async () =>
        (await pool.query("SELECT 1 FROM app.run_events WHERE run_id = $1", [id])).rowCount === 1,
    );
    child.kill("SIGKILL");
    await exited;

    // BullMQ hands the stalled job to the worker still standing, a few seconds later.
    const outcomes: DriveOutcome[] = [];
    const seen: Pick<Run, "resumed" | "crashes" | "checkpoint">[] = [];
    worker = createWorker<{ runId: string }>(
      "runs",
      async (job) => {
        const outcome = await runs.drive(job.data.runId, {
          report: async (run) => {
            seen.push({ resumed: run.resumed, crashes: run.crashes, checkpoint: run.checkpoint });
            run.emit("step", { n: 2 });
            return "done";
          },
        });
        outcomes.push(outcome);
      },
      { connection: redis, onError: (error) => void errors.push(error), stalledInterval: 1_000 },
    );
    await eventually(() => outcomes.length === 1, 20_000);

    expect(outcomes).toEqual(["succeeded"]);
    expect(seen).toEqual([{ resumed: true, crashes: 1, checkpoint: { step: 1 } }]);
    const { rows } = await pool.query<{ seq: number; type: string; data: unknown }>(
      "SELECT seq, type, data FROM app.run_events WHERE run_id = $1 ORDER BY seq",
      [id],
    );
    expect(rows).toEqual([
      { seq: 1, type: "step", data: { n: 1 } },
      { seq: 2, type: "step", data: { n: 2 } },
      { seq: 3, type: "end", data: { status: "succeeded", error: null } },
    ]);

    // A nudge for a run that already finished, the way the sweep sends one.
    await removeLeftoverJob(await queue.getJob(id));
    await queue.add("run", { runId: id }, { jobId: id });
    await eventually(() => outcomes.length === 2);
    expect(outcomes).toEqual(["succeeded", "skipped"]);
    expect(seen).toHaveLength(1);
    expect(errors).toEqual([]);
  }, 60_000);
});
