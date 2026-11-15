import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { createRuns, type StoredRun } from "./index.ts";

// Use the documented tables under another schema to check the configured table name too.
const TABLE_SQL = /```sql\n(CREATE TABLE app\.runs[\s\S]*?)```/.exec(
  readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
)?.[1];
const SPEC = { kind: "report", owner: "user-1", input: { topic: "rivers" } };

describe.skipIf(!hasPostgres)("runs.read against a real Postgres", () => {
  let server: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;

  beforeAll(async () => {
    server = await startPostgres();
    pool = new Pool({ connectionString: server.url });
    await pool.query("CREATE SCHEMA reader");
    if (!TABLE_SQL) throw new Error("The README's CREATE TABLE for app.runs is gone");
    await pool.query(TABLE_SQL.replaceAll("app.", "reader."));
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await server.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE reader.runs CASCADE");
  });

  const store = () =>
    createRuns(pool, {
      table: "reader.runs",
      events: "reader.run_events",
      onError: () => {},
    });

  it("reads queued, running and finished state from storage", async () => {
    const runs = store();
    const reader = store();
    const { id } = await runs.create(SPEC);
    const queued = { ...SPEC, id, status: "queued", checkpoint: null, result: null, error: null };
    expect(await reader.read(id, SPEC.owner)).toEqual(queued);

    const checkpoint = { notes: ["first", "second"] };
    const result = { pages: 3 };
    let running: StoredRun | null = null;
    expect(
      await runs.drive(id, {
        report: async (run) => {
          await run.save(checkpoint);
          running = await reader.read(id, SPEC.owner);
          return result;
        },
      }),
    ).toBe("succeeded");
    expect(running).toEqual({ ...queued, status: "running", checkpoint });
    expect(await reader.read(id, SPEC.owner)).toEqual({
      ...queued,
      status: "succeeded",
      checkpoint,
      result,
    });
    expectTypeOf<StoredRun["input"]>().toBeUnknown();
    expectTypeOf<StoredRun["checkpoint"]>().toBeUnknown();
    expectTypeOf<StoredRun["result"]>().toBeUnknown();
  });

  it("reads a failed run's error and last checkpoint", async () => {
    const runs = store();
    const { id } = await runs.create(SPEC);
    await runs.drive(id, {
      report: async (run) => {
        await run.save(0);
        throw new Error("Search failed");
      },
    });
    expect(await runs.read(id, SPEC.owner)).toEqual({
      ...SPEC,
      id,
      status: "failed",
      checkpoint: 0,
      result: null,
      error: { code: "handler", message: "Search failed" },
    });
  });

  it("returns null for a missing run", async () => {
    expect(await store().read(crypto.randomUUID(), SPEC.owner)).toBeNull();
  });

  it("requires both the run id and its owner to match", async () => {
    const runs = store();
    const first = await runs.create(SPEC);
    const second = await runs.create({ ...SPEC, owner: "user-2", input: "private" });
    expect(await runs.read(first.id, "user-2")).toBeNull();
    expect(await runs.read(second.id, SPEC.owner)).toBeNull();
    expect(await runs.read(second.id, "user-2")).toMatchObject({
      id: second.id,
      owner: "user-2",
      input: "private",
    });
  });
});
