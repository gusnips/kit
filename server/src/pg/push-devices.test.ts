import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { createPgPushDevices } from "./push-devices.ts";

/** The README's own `CREATE TABLE`, so the table the docs tell you to make is the one tested. */
const TABLE_SQL = /```sql\n(CREATE TABLE app\.push_devices[\s\S]*?)```/.exec(
  readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
)?.[1];

const ANA = "00000000-0000-4000-8000-00000000000a";
const BIA = "00000000-0000-4000-8000-00000000000b";

describe("createPgPushDevices", () => {
  it("refuses a table name it would have to write into the SQL", async () => {
    // A Pool connects on its first query, never on construction, so this one never dials.
    const pool = new Pool();
    expect(() => createPgPushDevices(pool, { table: "devices; DROP TABLE x" })).toThrow(TypeError);
    expect(() => createPgPushDevices(pool, { table: "app.push_devices" })).not.toThrow();
    await pool.end();
  });
});

describe.skipIf(!hasPostgres)("createPgPushDevices against a real Postgres", () => {
  let server: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;
  let devices: ReturnType<typeof createPgPushDevices>;

  beforeAll(async () => {
    server = await startPostgres();
    pool = new Pool({ connectionString: server.url });
    await pool.query("CREATE SCHEMA app");
    if (!TABLE_SQL) throw new Error("The README's CREATE TABLE for push_devices is gone");
    await pool.query(TABLE_SQL);
    devices = createPgPushDevices(pool, { table: "app.push_devices" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await server.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.push_devices");
  });

  it("lists a person's phones and nobody else's", async () => {
    await devices.register({ userId: ANA, token: "t-ana-ios", platform: "ios" });
    await devices.register({ userId: ANA, token: "t-ana-android", platform: "android" });
    await devices.register({ userId: BIA, token: "t-bia", platform: "ios" });
    const ana = await devices.listForUser(ANA);
    expect(ana.sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { token: "t-ana-android", platform: "android" },
      { token: "t-ana-ios", platform: "ios" },
    ]);
  });

  it("moves a phone to whoever signed in on it last", async () => {
    await devices.register({ userId: ANA, token: "t-shared", platform: "ios" });
    await pool.query("UPDATE app.push_devices SET last_seen_at = now() - interval '30 days'");
    await devices.register({ userId: BIA, token: "t-shared", platform: "ios" });
    expect(await devices.listForUser(ANA)).toEqual([]);
    expect(await devices.listForUser(BIA)).toEqual([{ token: "t-shared", platform: "ios" }]);
    const { rows } = await pool.query<{ fresh: boolean }>(
      "SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM app.push_devices",
    );
    expect(rows).toEqual([{ fresh: true }]);
  });

  it("signs out only the caller's own row", async () => {
    await devices.register({ userId: ANA, token: "t-ana", platform: "ios" });
    await devices.unregister(BIA, "t-ana");
    expect(await devices.listForUser(ANA)).toHaveLength(1);
    await devices.unregister(ANA, "t-ana");
    expect(await devices.listForUser(ANA)).toEqual([]);
  });

  it("removes a dead token whoever holds it", async () => {
    await devices.register({ userId: ANA, token: "t-dead", platform: "android" });
    await devices.remove("t-dead");
    expect(await devices.listForUser(ANA)).toEqual([]);
  });
});
