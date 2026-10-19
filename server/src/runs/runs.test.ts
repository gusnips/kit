import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventually } from "../__tests__/eventually.ts";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { createRuns, RunStopped, type Run, type RunsOptions } from "./index.ts";

/** The README's own `CREATE TABLE`s, so the tables the docs tell you to make are the ones tested. */
const TABLE_SQL = /```sql\n(CREATE TABLE app\.runs[\s\S]*?)```/.exec(
  readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
)?.[1];

const SPEC = { kind: "report", owner: "user-1", input: { topic: "rivers" } };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe.skipIf(!hasPostgres)("createRuns against a real Postgres", () => {
  let server: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;
  let errors: unknown[];

  beforeAll(async () => {
    server = await startPostgres();
    pool = new Pool({ connectionString: server.url, max: 30 });
    await pool.query("CREATE SCHEMA app");
    if (!TABLE_SQL) throw new Error("The README's CREATE TABLE for app.runs is gone");
    await pool.query(TABLE_SQL);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await server.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.runs CASCADE");
    errors = [];
  });

  const store = (options: Partial<RunsOptions> = {}, db: Pick<Pool, "query"> = pool) =>
    createRuns(db, {
      table: "app.runs",
      events: "app.run_events",
      onError: (error) => errors.push(error),
      ...options,
    });

  const rowOf = async (id: string) =>
    (
      await pool.query<{
        status: string;
        error: unknown;
        checkpoint: unknown;
        result: string | null;
        crashes: number;
      }>("SELECT status, error, checkpoint, result::text, crashes FROM app.runs WHERE id = $1", [
        id,
      ])
    ).rows[0];

  const eventsOf = async (id: string) =>
    (
      await pool.query<{ seq: number; type: string; data: unknown }>(
        "SELECT seq, type, data FROM app.run_events WHERE run_id = $1 ORDER BY seq",
        [id],
      )
    ).rows;

  /** What a worker that died looks like from the outside: its lease ran out. */
  const expireLease = (id: string) =>
    pool.query("UPDATE app.runs SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);

  /**
   * A worker that took the run, saved `{ step: 1 }` and three events, and then stopped answering:
   * its handler waits on `resume`, and its heartbeat (every 10 s) does not come in a test.
   */
  async function stalledWorker(id: string) {
    const started = gate();
    const resume = gate();
    let run: Run | undefined;
    const driving = store().drive(id, {
      report: async (r) => {
        run = r;
        for (const n of [1, 2, 3]) r.emit("step", { n });
        await r.save({ step: 1 });
        started.open();
        await resume.opened;
        return "late";
      },
    });
    await started.opened;
    // emit does not wait for its write, so the worker "dies" only once all three are stored.
    await eventually(async () => (await eventsOf(id)).length === 3);
    return { driving, resume, signal: () => run?.signal };
  }

  it("runs a queued run once, and keeps its result and events in order", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const outcome = await runs.drive(id, {
      report: async (run) => {
        expect(run).toMatchObject({ input: { topic: "rivers" }, resumed: false, crashes: 0 });
        expect(run.checkpoint).toBeNull();
        for (const n of [1, 2, 3]) run.emit("step", { n });
        return { zeta: 1, alpha: 2 };
      },
    });
    expect(outcome).toBe("succeeded");
    expect(await rowOf(id)).toMatchObject({
      status: "succeeded",
      error: null,
      result: '{"zeta":1,"alpha":2}',
    });
    expect(await eventsOf(id)).toEqual([
      { seq: 1, type: "step", data: { n: 1 } },
      { seq: 2, type: "step", data: { n: 2 } },
      { seq: 3, type: "step", data: { n: 3 } },
      { seq: 4, type: "end", data: { status: "succeeded", error: null } },
    ]);
  });

  it("lets exactly one of ten workers claim a run", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const { open, opened } = gate();
    let ran = 0;
    let settled = 0;
    const outcomes = Promise.all(
      Array.from({ length: 10 }, () =>
        runs
          .drive(id, {
            report: async () => {
              ran++;
              await opened;
            },
          })
          .finally(() => settled++),
      ),
    );
    // Held open until the other nine have answered, so all ten overlap however slow the machine is.
    await eventually(() => settled === 9);
    open();
    const sorted = (await outcomes).sort();
    expect(ran).toBe(1);
    expect(sorted).toEqual(["skipped", ...Array<string>(8).fill("skipped"), "succeeded"].sort());
  });

  it("keeps a throw as the run's error, and hands the error itself to onError", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const thrown = new Error("provider down");
    expect(await runs.drive(id, { report: () => Promise.reject(thrown) })).toBe("failed");
    expect(await rowOf(id)).toMatchObject({
      status: "failed",
      error: { code: "handler", message: "provider down" },
    });
    expect((await eventsOf(id)).at(-1)).toEqual({
      seq: 1,
      type: "end",
      data: { status: "failed", error: { code: "handler", message: "provider down" } },
    });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).cause).toBe(thrown);

    const { id: unknownKind } = await runs.create({ ...SPEC, kind: "constructor" });
    expect(await runs.drive(unknownKind, { report: async () => "never" })).toBe("failed");
    expect((await rowOf(unknownKind))?.error).toEqual({
      code: "handler",
      message: 'No handler for kind "constructor". Add it to the handlers passed to drive.',
    });
  });

  it("does nothing for a finished run, or one that does not exist", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    let ran = 0;
    const handlers = { report: async () => ++ran };
    expect(await runs.drive(id, handlers)).toBe("succeeded");
    expect(await runs.drive(id, handlers)).toBe("skipped");
    expect(await runs.drive(crypto.randomUUID(), handlers)).toBe("skipped");
    expect(ran).toBe(1);
  });

  it("lets a worker past its lease write nothing, and resumes the next at the next seq", async () => {
    // The plan's case in real time: a 1-second lease, and a heartbeat that stops answering, as
    // in a process that is paused rather than dead.
    let paused = false;
    // The cast: pg's `query` has eight overloads, and this stub forwards the one the module calls.
    const pausable = {
      query: (text: string, values?: unknown[]) =>
        paused && text.includes("RETURNING cancel_requested_at")
          ? new Promise<never>(() => {})
          : pool.query(text, values),
    } as unknown as Pick<Pool, "query">;
    const a = store({ leaseSecs: 1 }, pausable);
    const { id } = await a.create({ ...SPEC, restart: "resume" });
    const aStarted = gate();
    const aLate = gate();
    let aRun: Run | undefined;
    let aSave: unknown;
    const aDriving = a.drive(id, {
      report: async (run) => {
        aRun = run;
        for (const n of [1, 2, 3]) run.emit("step", { n });
        await run.save({ step: 1 });
        paused = true;
        aStarted.open();
        await aLate.opened;
        run.emit("late", {});
        aSave = await run.save({ step: 99 }).catch((error: unknown) => error);
        return "late";
      },
    });
    await aStarted.opened;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const bStarted = gate();
    const bDone = gate();
    let bRun: Run | undefined;
    const bDriving = store({ leaseSecs: 1 }).drive(id, {
      report: async (run) => {
        bRun = run;
        bStarted.open();
        await bDone.opened;
        run.emit("step", { n: 4 });
        await run.save({ step: 2 });
        return "done";
      },
    });
    await bStarted.opened;
    expect(bRun).toMatchObject({ resumed: true, crashes: 1, checkpoint: { step: 1 } });

    aLate.open();
    expect(await aDriving).toBe("lost");
    expect(aSave).toBeInstanceOf(RunStopped);
    expect(aRun?.signal.reason).toMatchObject({ code: "lost" });
    bDone.open();
    expect(await bDriving).toBe("succeeded");

    expect((await rowOf(id))?.checkpoint).toEqual({ step: 2 });
    expect((await eventsOf(id)).map((e) => `${e.seq} ${e.type}`)).toEqual([
      "1 step",
      "2 step",
      "3 step",
      "4 step",
      "5 end",
    ]);
    expect(errors).toEqual([]);
  }, 15_000);

  it.each([
    ["fail", null],
    ["restart", null],
    ["resume", { step: 1 }],
  ] as const)("after a worker dies, a %s run does what its policy says", async (restart, kept) => {
    const runs = store();
    const { id } = await runs.create({ ...SPEC, restart });
    const dead = await stalledWorker(id);
    await expireLease(id);

    let next: Run | undefined;
    const outcome = await runs.drive(id, {
      report: async (run) => {
        next = run;
        return "again";
      },
    });

    if (restart === "fail") {
      expect(outcome).toBe("failed");
      expect(next).toBeUndefined();
      expect(await rowOf(id)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
      expect((await eventsOf(id)).at(-1)).toEqual({
        seq: 4,
        type: "end",
        data: { status: "failed", error: { code: "interrupted" } },
      });
    } else {
      expect(outcome).toBe("succeeded");
      expect(next).toMatchObject({ resumed: true, crashes: 1 });
      expect(next?.checkpoint).toEqual(kept);
    }
    dead.resume.open();
    expect(await dead.driving).toBe("lost");
    expect(dead.signal()?.reason).toMatchObject({ code: "lost" });
  });

  it("takes over a dead worker's run five times, and ends it on the sixth", async () => {
    const runs = store();
    const crashed = async (crashes: number) => {
      const { id } = await runs.create({ ...SPEC, restart: "resume" });
      await pool.query(
        `UPDATE app.runs SET status = 'running', lease_token = gen_random_uuid(), crashes = $2,
           lease_until = now() - interval '1 second', started_at = now() WHERE id = $1`,
        [id, crashes],
      );
      return id;
    };
    let ran = 0;
    const handlers = { report: async (run: Run) => (ran++, run.crashes) };

    const fifth = await crashed(4);
    expect(await runs.drive(fifth, handlers)).toBe("succeeded");
    expect(await rowOf(fifth)).toMatchObject({ crashes: 5, result: "5" });

    const sixth = await crashed(5);
    expect(await runs.drive(sixth, handlers)).toBe("failed");
    expect(await rowOf(sixth)).toMatchObject({
      status: "failed",
      error: { code: "restart_limit" },
    });
    expect(ran).toBe(1);
  });

  it("tails the events after a seq, then each new one, until the run ends", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const next = gate();
    const driving = runs.drive(id, {
      report: async (run) => {
        run.emit("a", 1);
        await next.opened;
        run.emit("b", 2);
      },
    });
    const seen: string[] = [];
    const tailing = (async () => {
      for await (const event of runs.tail(id)) seen.push(`${event.seq} ${event.type}`);
    })();
    await eventually(() => seen.length === 1);
    next.open();
    await driving;
    await tailing;
    expect(seen).toEqual(["1 a", "2 b", "3 end"]);

    const after: number[] = [];
    for await (const event of runs.tail(id, 2)) after.push(event.seq);
    expect(after).toEqual([3]);
  });

  it("stops tailing when the signal aborts", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const seen: unknown[] = [];
    for await (const event of runs.tail(id, 0, stop.signal)) seen.push(event);
    expect(seen).toEqual([]);
  });

  it("creates the run inside the caller's transaction", async () => {
    const runs = store();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { id } = await runs.create(SPEC, client);
      await client.query("ROLLBACK");
      expect(await rowOf(id)).toBeUndefined();
    } finally {
      client.release();
    }
  });

  it("refuses a table it would have to quote, and a lease BullMQ would re-run inside", () => {
    for (const table of ["app.runs; DROP TABLE users", "a.b.c", ""])
      expect(() => store({ table })).toThrow(TypeError);
    expect(() => store({ events: "app.run events" })).toThrow(TypeError);
    for (const leaseSecs of [0, 31, Number.NaN])
      expect(() => store({ leaseSecs })).toThrow("leaseSecs must be above 0 and at most 30");
  });
});
