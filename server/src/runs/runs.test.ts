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

  const store = (options: Partial<RunsOptions> = {}, db: Pick<Pool, "query" | "connect"> = pool) =>
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
   * its handler waits on `resume`, and its heartbeat (every 5 s) does not come in a test.
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

  /**
   * A pool whose first query matching `match` runs in a transaction of its own, and keeps its
   * locks until `release()`: a write caught in flight, at the moment a close or a claim must wait.
   */
  function holding(match: (text: string) => boolean) {
    const held = gate();
    const released = gate();
    let armed = true;
    // The cast: pg's `query` has eight overloads, and this stub forwards the one the module calls.
    const db = {
      connect: () => pool.connect(),
      query: async (text: string, values?: unknown[]) => {
        if (!(armed && match(text))) return pool.query(text, values);
        armed = false;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query(text, values);
          held.open();
          await released.opened;
          await client.query("COMMIT");
          return result;
        } finally {
          client.release();
        }
      },
    } as unknown as Pick<Pool, "query" | "connect">;
    return { db, held: held.opened, release: released.open };
  }
  const isAppend = (text: string) => text.startsWith("INSERT INTO app.run_events");
  const isAddChild = (text: string) =>
    text.startsWith("INSERT INTO app.runs (id, root_id, parent_id");

  /** True once a statement waits on a row lock: the close or the claim under test is held up. */
  const blocked = async () =>
    (
      await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
      )
    ).rows.length > 0;

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

    // A throw that cannot even be turned into a string is still the handler's failure.
    const { id: odd } = await runs.create(SPEC);
    expect(await runs.drive(odd, { report: () => Promise.reject(Object.create(null)) })).toBe(
      "failed",
    );
    expect((await rowOf(odd))?.error).toEqual({ code: "handler", message: "[object Object]" });
  });

  it("rejects a save JSON cannot hold, instead of throwing", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    let how = "";
    await runs.drive(id, {
      report: async (run) => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        try {
          await run.save(loop).catch(() => (how = "rejected"));
        } catch {
          how = "threw";
        }
      },
    });
    expect(how).toBe("rejected");
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
    // A worker paused past its lease, as in a long garbage collection: its own clock has not run
    // out yet, so its late writes reach the database, and the database has handed the run on.
    const a = store();
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
        aStarted.open();
        await aLate.opened;
        run.emit("late", {});
        aSave = await run.save({ step: 99 }).catch((error: unknown) => error);
        return "late";
      },
    });
    await aStarted.opened;
    await eventually(async () => (await eventsOf(id)).length === 3);
    await expireLease(id);

    const bStarted = gate();
    const bDone = gate();
    let bRun: Run | undefined;
    const bDriving = store().drive(id, {
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
  });

  it("stops a run itself once a whole lease passes with no heartbeat answered", async () => {
    // A heartbeat that hangs, on a stuck pool or a dropped network, never answers either way.
    let hanging = false;
    // The cast: pg's `query` has eight overloads, and this stub forwards the one the module calls.
    const hangs = {
      connect: () => pool.connect(),
      query: (text: string, values?: unknown[]) =>
        hanging && text.includes("RETURNING cancel_requested_at")
          ? new Promise<never>(() => {})
          : pool.query(text, values),
    } as unknown as Pick<Pool, "query" | "connect">;
    const a = store({ leaseSecs: 1 }, hangs);
    const { id } = await a.create({ ...SPEC, restart: "resume" });
    const aStopped = gate();
    let aRun: Run | undefined;
    const aDriving = a.drive(id, {
      report: async (run) => {
        aRun = run;
        hanging = true;
        await run.save({ step: 1 });
        await new Promise((resolve) => run.signal.addEventListener("abort", resolve));
        aStopped.open();
        run.emit("late", {});
        return run.save({ step: 99 });
      },
    });
    await aStopped.opened;
    expect(aRun?.signal.reason).toMatchObject({ code: "lost" });
    expect(await aDriving).toBe("lost");

    // Nothing was written for it: the run waits for its lease to run out, as a dead worker's does.
    expect(await rowOf(id)).toMatchObject({ status: "running", checkpoint: { step: 1 } });
    await eventually(
      async () =>
        (await pool.query("SELECT 1 FROM app.runs WHERE id = $1 AND lease_until < now()", [id]))
          .rows.length > 0,
    );
    let next: Run | undefined;
    const outcome = await store().drive(id, {
      report: async (run) => {
        next = run;
        return "done";
      },
    });
    expect(outcome).toBe("succeeded");
    expect(next).toMatchObject({ resumed: true, crashes: 1, checkpoint: { step: 1 } });
    expect(await eventsOf(id)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

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

  const childOf = async (parentId: string, key: string) =>
    (
      await pool.query<{ id: string }>(
        "SELECT id FROM app.runs WHERE parent_id = $1 AND child_key = $2",
        [parentId, key],
      )
    ).rows[0]?.id ?? "";

  it("never runs a finished child again, and resumes the one its dead worker left", async () => {
    const { id } = await store().create({ ...SPEC, restart: "resume" });
    const calls: string[] = [];
    const started = gate();
    const stuck = gate();
    const first = store().drive(id, {
      report: async (run) => {
        await run.child("a", { kind: "search", input: 1 }, async () => {
          calls.push("a");
          return { found: 3 };
        });
        return run.child("b", { kind: "write", input: 2 }, async (b) => {
          calls.push("b");
          b.emit("draft", 1);
          await b.save({ page: 1 });
          started.open();
          await stuck.opened;
          return "late";
        });
      },
    });
    await started.opened;
    const b = await childOf(id, "b");
    await eventually(async () => (await eventsOf(b)).length === 1);
    await expireLease(id);

    const seen: Pick<Run, "resumed" | "crashes" | "checkpoint">[] = [];
    const outcome = await store().drive(id, {
      report: async (run) => ({
        a: await run.child("a", { kind: "search", input: 1 }, async () => calls.push("a again")),
        b: await run.child("b", { kind: "write", input: 2 }, async (child) => {
          seen.push({
            resumed: child.resumed,
            crashes: child.crashes,
            checkpoint: child.checkpoint,
          });
          child.emit("draft", 2);
          return "done";
        }),
      }),
    });

    expect(outcome).toBe("succeeded");
    expect(calls).toEqual(["a", "b"]);
    expect(seen).toEqual([{ resumed: true, crashes: 1, checkpoint: { page: 1 } }]);
    expect(JSON.parse((await rowOf(id))?.result ?? "")).toEqual({
      a: { ok: true, value: { found: 3 } },
      b: { ok: true, value: "done" },
    });
    expect(await eventsOf(b)).toEqual([
      { seq: 1, type: "draft", data: 1 },
      { seq: 2, type: "draft", data: 2 },
      { seq: 3, type: "end", data: { status: "succeeded", error: null } },
    ]);
    stuck.open();
    expect(await first).toBe("lost");
  });

  it("hands a child's failure back as data, and refuses a key already running", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const outcome = await runs.drive(id, {
      report: async (run) => {
        const failed = await run.child("a", { kind: "search", input: null }, async () => {
          throw new Error("no results");
        });
        const twice = Promise.all([
          run.child("b", { kind: "search", input: null }, async () => "one"),
          run.child("b", { kind: "search", input: null }, async () => "two"),
        ]);
        await expect(twice).rejects.toThrow('already has a child "b" running');
        return failed;
      },
    });
    expect(outcome).toBe("succeeded");
    expect(JSON.parse((await rowOf(id))?.result ?? "")).toEqual({
      ok: false,
      error: { code: "handler", message: "no results" },
    });
    expect(await eventsOf(await childOf(id, "a"))).toEqual([
      {
        seq: 1,
        type: "end",
        data: { status: "failed", error: { code: "handler", message: "no results" } },
      },
    ]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).cause).toMatchObject({ message: "no results" });
  });

  it("cancels a queued run at once, and a running one with every child under it", async () => {
    const runs = store({ leaseSecs: 1 });
    const queued = await runs.create(SPEC);
    expect(await runs.cancel(queued.id)).toBe(true);
    expect(await rowOf(queued.id)).toMatchObject({ status: "cancelled" });
    expect(await eventsOf(queued.id)).toEqual([
      { seq: 1, type: "end", data: { status: "cancelled", error: null } },
    ]);
    expect(await runs.drive(queued.id, {})).toBe("skipped");

    const { id } = await runs.create(SPEC);
    const reached = gate();
    let leaf: Run | undefined;
    const driving = runs.drive(id, {
      report: async (run) => {
        const child = await run.child("plan", { kind: "plan", input: null }, async (plan) => {
          const grandchild = await plan.child("search", { kind: "search", input: null }, (r) => {
            leaf = r;
            reached.open();
            return new Promise((_, reject) =>
              r.signal.addEventListener("abort", () => reject(r.signal.reason)),
            );
          });
          if (!grandchild.ok) throw new Error(grandchild.error.code);
        });
        if (!child.ok) throw new Error(child.error.code);
      },
    });
    await reached.opened;
    // A child's id cancels the tree it is in.
    expect(await runs.cancel(leaf?.id ?? "")).toBe(true);
    expect(await driving).toBe("cancelled");
    expect(leaf?.signal.reason).toMatchObject({ code: "cancelled" });

    const { rows } = await pool.query<{ id: string; depth: number; status: string }>(
      "SELECT id, depth, status FROM app.runs WHERE root_id = $1 ORDER BY depth",
      [id],
    );
    expect(rows.map(({ depth, status }) => [depth, status])).toEqual([
      [0, "cancelled"],
      [1, "cancelled"],
      [2, "cancelled"],
    ]);
    for (const row of rows)
      expect((await eventsOf(row.id)).at(-1)?.data).toEqual({ status: "cancelled", error: null });
    expect(await runs.cancel(id)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("refuses a new child past the budget, with what earlier attempts spent counted", async () => {
    const { id } = await store().create({ ...SPEC, restart: "resume", limits: { budgetUsd: 1 } });
    const spent = gate();
    const stuck = gate();
    const first = store().drive(id, {
      report: async (run) => {
        await run.spend(0.6);
        await run.child("a", { kind: "search", input: null }, (child) => child.spend(0.5));
        spent.open();
        await stuck.opened;
      },
    });
    await spent.opened;
    await expireLease(id);

    let ran = false;
    await store().drive(id, {
      report: (run) =>
        run.child("b", { kind: "search", input: null }, async () => {
          ran = true;
        }),
    });
    expect(ran).toBe(false);
    expect(JSON.parse((await rowOf(id))?.result ?? "")).toEqual({
      ok: false,
      error: { code: "budget", message: "The tree spent $1.1 of its $1 budget." },
    });
    expect(await childOf(id, "b")).toBe("");
    stuck.open();
    expect(await first).toBe("lost");
  });

  it("refuses a child past maxDepth or maxChildren", async () => {
    const runs = store();
    const { id } = await runs.create({ ...SPEC, limits: { maxDepth: 1, maxChildren: 2 } });
    await runs.drive(id, {
      report: async (run) => {
        const deep = await run.child("a", { kind: "plan", input: null }, (child) =>
          child.child("deep", { kind: "search", input: null }, async () => "never"),
        );
        const both = await Promise.all(
          ["b", "c"].map((key) => run.child(key, { kind: "search", input: null }, async () => key)),
        );
        return { deep, both };
      },
    });
    expect(JSON.parse((await rowOf(id))?.result ?? "")).toEqual({
      deep: {
        ok: true,
        value: {
          ok: false,
          error: { code: "max_depth", message: "A child here would be at depth 2. maxDepth is 1." },
        },
      },
      both: [
        { ok: true, value: "b" },
        {
          ok: false,
          error: {
            code: "max_children",
            message: "The tree already started 2 children. maxChildren is 2.",
          },
        },
      ],
    });
  });

  it.each([1, 2])(
    "runs at most maxParallel %i children at once, and a tree deeper than that finishes",
    async (maxParallel) => {
      const runs = store();
      const { id } = await runs.create({ ...SPEC, limits: { maxParallel } });
      let now = 0;
      let peak = 0;
      const leaf = async () => {
        peak = Math.max(peak, ++now);
        await new Promise((resolve) => setTimeout(resolve, 20));
        now--;
        return "leaf";
      };
      const outcome = await runs.drive(id, {
        report: (run) =>
          Promise.all(
            ["a", "b", "c"].map((key) =>
              run.child(key, { kind: "plan", input: null }, (child) =>
                Promise.all(
                  ["x", "y"].map((sub) => child.child(sub, { kind: "search", input: null }, leaf)),
                ),
              ),
            ),
          ),
      });
      expect(outcome).toBe("succeeded");
      expect(peak).toBe(maxParallel);
      const { rows } = await pool.query(
        "SELECT 1 FROM app.runs WHERE root_id = $1 AND status = 'succeeded'",
        [id],
      );
      expect(rows).toHaveLength(10);
    },
  );

  it("sends out stale queued runs and dead runs that can go on, and ends the rest", async () => {
    const runs = store();
    const stale = (await runs.create(SPEC)).id;
    const fresh = (await runs.create(SPEC)).id;
    const resumable = (await runs.create({ ...SPEC, restart: "resume" })).id;
    const failing = (await runs.create(SPEC)).id;
    await pool.query(
      "UPDATE app.runs SET updated_at = now() - interval '3 minutes' WHERE id = $1",
      [stale],
    );
    await pool.query(
      `UPDATE app.runs SET status = 'running', lease_token = gen_random_uuid(),
         lease_until = now() - interval '1 second', started_at = now() WHERE id = ANY($1)`,
      [[resumable, failing]],
    );

    const nudged: string[] = [];
    const nudge = (id: string) => {
      nudged.push(id);
      if (id === resumable) throw new Error("Redis is down");
    };
    expect(await runs.sweep({ nudge })).toEqual({ nudged: 1, ended: 1 });
    expect(nudged.sort()).toEqual([stale, resumable].sort());
    expect(errors).toHaveLength(1);
    expect(await rowOf(failing)).toMatchObject({
      status: "failed",
      error: { code: "interrupted" },
    });
    expect(await eventsOf(failing)).toEqual([
      { seq: 1, type: "end", data: { status: "failed", error: { code: "interrupted" } } },
    ]);

    // Its clock started again; the dead run is still dead. On boot, everything queued goes out.
    nudged.length = 0;
    await runs.sweep({ nudge });
    expect(nudged).toEqual([resumable]);
    nudged.length = 0;
    await runs.sweep({ nudge, olderThanSecs: 0 });
    expect(nudged.sort()).toEqual([stale, fresh, resumable].sort());
  });

  it("drains: waits, then puts a resumable tree back in the queue and ends a fail run", async () => {
    const runs = store();
    const quick = (await runs.create(SPEC)).id;
    const resumable = (await runs.create({ ...SPEC, restart: "resume" })).id;
    const failing = (await runs.create(SPEC)).id;
    const started = [gate(), gate(), gate()];
    const stopped: unknown[] = [];
    const ignoring = gate();

    const done = runs.drive(quick, {
      report: async () => {
        started[0]?.open();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "made it";
      },
    });
    const requeued = runs.drive(resumable, {
      report: async (run) => {
        await run.save({ step: 1 });
        return run.child("search", { kind: "search", input: null }, (child) => {
          started[1]?.open();
          return new Promise((_, reject) =>
            child.signal.addEventListener("abort", () => {
              stopped.push(child.signal.reason);
              reject(child.signal.reason);
            }),
          );
        });
      },
    });
    // This handler ignores its signal, and the drain does not wait for it.
    const failed = runs.drive(failing, {
      report: async (run) => {
        started[2]?.open();
        await ignoring.opened;
        await run.save({ late: true }).catch((error: unknown) => stopped.push(error));
      },
    });
    await Promise.all(started.map(({ opened }) => opened));

    await runs.drain(500);
    expect(await done).toBe("succeeded");
    expect(await requeued).toBe("requeued");
    expect(stopped).toMatchObject([{ code: "shutdown" }]);
    expect(await rowOf(resumable)).toMatchObject({
      status: "queued",
      crashes: 0,
      checkpoint: { step: 1 },
    });
    expect(await rowOf(await childOf(resumable, "search"))).toMatchObject({ status: "queued" });
    expect(await rowOf(failing)).toMatchObject({
      status: "failed",
      error: { code: "interrupted" },
    });
    expect(await runs.drive((await runs.create(SPEC)).id, {})).toBe("skipped");

    ignoring.open();
    expect(await failed).toBe("failed");
    expect(stopped.at(-1)).toMatchObject({ code: "shutdown" });

    // The next process: the sweep sends it out, and it goes on with its child, no crash counted.
    const next = store();
    const nudged: string[] = [];
    await next.sweep({ nudge: (id) => void nudged.push(id), olderThanSecs: 0 });
    expect(nudged).toContain(resumable);
    let seen: Pick<Run, "resumed" | "crashes" | "checkpoint"> | undefined;
    const outcome = await next.drive(resumable, {
      report: (run) =>
        run.child("search", { kind: "search", input: null }, async (child) => {
          seen = { resumed: child.resumed, crashes: child.crashes, checkpoint: run.checkpoint };
          return "found";
        }),
    });
    expect(outcome).toBe("succeeded");
    expect(seen).toEqual({ resumed: true, crashes: 0, checkpoint: { step: 1 } });
  });

  it("hands back a run whose claim was in flight when the drain began", async () => {
    const claiming = gate();
    const claimed = gate();
    // The cast: pg's `query` has eight overloads, and this stub forwards the one the module calls.
    const slow = {
      connect: () => pool.connect(),
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith("WITH prev AS")) {
          claiming.open();
          await claimed.opened;
        }
        return pool.query(text, values);
      },
    } as unknown as Pick<Pool, "query" | "connect">;
    const runs = store({}, slow);
    const { id } = await runs.create(SPEC);
    let ran = false;
    const driving = runs.drive(id, {
      report: async () => {
        ran = true;
      },
    });
    await claiming.opened;
    await runs.drain(0);
    claimed.open();
    // A `fail` run too: its handler never started, so nothing of it ran.
    expect(await driving).toBe("requeued");
    expect(ran).toBe(false);
    expect(await rowOf(id)).toMatchObject({ status: "queued", error: null, crashes: 0 });
  });

  it("lets an append in flight commit before a drain closes the run", async () => {
    const { db, held, release } = holding(isAppend);
    const runs = store({}, db);
    const { id } = await runs.create(SPEC);
    const driving = runs.drive(id, {
      report: async (run) => {
        run.emit("delta", 1);
        await new Promise((resolve) => run.signal.addEventListener("abort", resolve));
      },
    });
    await held;
    const drained = runs.drain(0);
    await eventually(blocked);
    release();
    await drained;
    expect(await driving).toBe("failed");
    expect((await eventsOf(id)).map((e) => `${e.seq} ${e.type}`)).toEqual(["1 delta", "2 end"]);
    expect(await rowOf(id)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(errors).toEqual([]);
  });

  it("closes a child whose insert was in flight when the drain began", async () => {
    const { db, held, release } = holding(isAddChild);
    const runs = store({}, db);
    const { id } = await runs.create(SPEC);
    const driving = runs.drive(id, {
      report: (run) => run.child("c", { kind: "search", input: null }, async () => "done"),
    });
    await held;
    const drained = runs.drain(0);
    await eventually(blocked);
    release();
    await drained;
    expect(await driving).toBe("failed");
    const child = await childOf(id, "c");
    expect(await rowOf(child)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(await eventsOf(child)).toEqual([
      { seq: 1, type: "end", data: { status: "failed", error: { code: "interrupted" } } },
    ]);
    expect(errors).toEqual([]);
  });

  it("closes a child whose insert was in flight when a sweep ended its dead root", async () => {
    const { db, held, release } = holding(isAddChild);
    const zombie = store({}, db);
    const { id } = await zombie.create(SPEC);
    const go = gate();
    const done = gate();
    const driving = zombie.drive(id, {
      report: async (run) => {
        await go.opened;
        return run.child("c", { kind: "search", input: null }, () => done.opened);
      },
    });
    await eventually(async () => (await rowOf(id))?.status === "running");
    await expireLease(id);
    go.open();
    await held;
    const sweeping = store().sweep({ nudge: () => {} });
    await eventually(blocked);
    release();
    expect(await sweeping).toEqual({ nudged: 0, ended: 1 });
    const child = await childOf(id, "c");
    expect(await rowOf(child)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    const tailed: string[] = [];
    for await (const event of store().tail(child)) tailed.push(event.type);
    expect(tailed).toEqual(["end"]);
    done.open();
    expect(await driving).toBe("lost");
  });

  it("counts a spend that was in flight when the run was taken over", async () => {
    const { db, held, release } = holding((text) => text.includes("cost_usd = c.cost_usd + $4"));
    const a = store({}, db);
    const { id } = await a.create({ ...SPEC, restart: "resume", limits: { budgetUsd: 0.5 } });
    const go = gate();
    const done = gate();
    const aDriving = a.drive(id, {
      report: async (run) => {
        await go.opened;
        await run.spend(0.6);
        await done.opened;
      },
    });
    await eventually(async () => (await rowOf(id))?.status === "running");
    await expireLease(id);
    go.open();
    await held;
    let ran = false;
    const taking = store().drive(id, {
      report: (run) =>
        run.child("b", { kind: "search", input: null }, async () => {
          ran = true;
        }),
    });
    await eventually(blocked);
    release();
    expect(await taking).toBe("succeeded");
    expect(ran).toBe(false);
    expect(JSON.parse((await rowOf(id))?.result ?? "")).toMatchObject({
      ok: false,
      error: { code: "budget" },
    });
    done.open();
    expect(await aDriving).toBe("lost");
  });

  it("ends a child still open when its root finishes", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    const started = gate();
    const late = gate();
    let open: Promise<unknown> | undefined;
    const outcome = await runs.drive(id, {
      report: async (run) => {
        open = run.child("c", { kind: "search", input: null }, async () => {
          started.open();
          await late.opened;
          return "late";
        });
        await started.opened;
        return "done";
      },
    });
    expect(outcome).toBe("succeeded");
    const child = await childOf(id, "c");
    expect(await rowOf(child)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(await eventsOf(child)).toEqual([
      { seq: 1, type: "end", data: { status: "failed", error: { code: "interrupted" } } },
    ]);
    late.open();
    await expect(open).rejects.toMatchObject({ code: "lost" });
    expect(errors).toEqual([]);
  });

  it("refuses a write through a child that already returned, and leaves the tree alone", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    let late: unknown[] = [];
    const outcome = await runs.drive(id, {
      report: async (run) => {
        let leaked: Run | undefined;
        await run.child("a", { kind: "search", input: null }, async (child) => {
          leaked = child;
          return 1;
        });
        late = await Promise.all([
          leaked?.spend(0.01).catch((error: unknown) => error),
          leaked?.save({}).catch((error: unknown) => error),
          leaked?.child("b", { kind: "search", input: null }, async () => 2).catch((e) => e),
        ]);
        leaked?.emit("late", {});
        return run.signal.aborted;
      },
    });
    expect(outcome).toBe("succeeded");
    expect((await rowOf(id))?.result).toBe("false");
    expect(errors).toHaveLength(1);
    for (const error of [...late, ...errors]) {
      expect(error).not.toBeInstanceOf(RunStopped);
      expect(error).toMatchObject({ message: expect.stringContaining("already ended") });
    }
    expect(await eventsOf(await childOf(id, "a"))).toHaveLength(1);
  });

  it("prunes finished runs older than the cutoff, with their children and events", async () => {
    const runs = store();
    const old = (await runs.create(SPEC)).id;
    await runs.drive(old, {
      report: (run) => run.child("a", { kind: "search", input: null }, async () => "x"),
    });
    const recent = (await runs.create(SPEC)).id;
    await runs.drive(recent, { report: async () => "y" });
    const open = (await runs.create(SPEC)).id;
    await pool.query(
      "UPDATE app.runs SET finished_at = now() - interval '8 days' WHERE root_id = $1",
      [old],
    );

    expect(await runs.prune(7)).toBe(1);
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM app.runs ORDER BY created_at",
    );
    expect(rows.map(({ id }) => id)).toEqual([recent, open]);
    expect(await eventsOf(old)).toEqual([]);
    await expect(runs.prune(1.5)).rejects.toThrow("days is a whole number");
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
    for (const leaseSecs of [0, 16, Number.NaN])
      expect(() => store({ leaseSecs })).toThrow("leaseSecs must be above 0 and at most 15");
  });

  it("refuses a limit that is not a count, or a maxParallel of 0", async () => {
    const runs = store();
    await expect(runs.create({ ...SPEC, limits: { maxParallel: 0 } })).rejects.toThrow(
      "limits.maxParallel is a whole number of 1 or more, not 0",
    );
    await expect(runs.create({ ...SPEC, limits: { maxChildren: 1.5 } })).rejects.toThrow(
      "limits.maxChildren is a whole number of 0 or more, not 1.5",
    );
    await expect(runs.create({ ...SPEC, limits: { budgetUsd: -1 } })).rejects.toThrow(
      "limits.budgetUsd is a number of 0 or more, not -1",
    );
  });
});
