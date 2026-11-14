/**
 * `/push`'s device table, kept in Postgres: the table in the README, one row per phone.
 *
 * A row is a push token, the person it belongs to and the platform that delivers to it. The token
 * is the key, because it names a phone and not a person: when a phone signs in to another account,
 * registering moves the row, and the first account stops getting that phone's pushes.
 *
 * Here rather than in `/push`, because `/push` needs only `node:http2` and `fetch`. An app that
 * keeps its devices somewhere else installs no `pg` for the transports.
 */
import type { Pool } from "pg";
import type { PushDevice, PushDeviceRepository, PushPlatform } from "../node/push/index.ts";

export interface PgPushDevicesOptions {
  /** The table from the README, with its schema if it has one: `app.push_devices`. */
  table: string;
}

export interface PgPushDevices extends PushDeviceRepository {
  /**
   * A phone said its token after a sign-in or at launch. A token already on file moves to this
   * person, and `last_seen_at` moves to now, so a row nobody refreshes for months can be pruned.
   */
  register(device: { userId: string; token: string; platform: PushPlatform }): Promise<void>;
  /**
   * Sign-out on this phone. Deletes the row only while it is still this person's, so a request
   * that names somebody else's token deletes nothing.
   */
  unregister(userId: string, token: string): Promise<void>;
}

/** A name or `schema.name`, because the table is written into the SQL, not passed as a value. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 *     const pushDevices = createPgPushDevices(pool, { table: "app.push_devices" });
 *     const push = createPushNotifier({ transports, devices: pushDevices, logger });
 */
export function createPgPushDevices(
  pool: Pick<Pool, "query">,
  options: PgPushDevicesOptions,
): PgPushDevices {
  const { table } = options;
  if (!TABLE_NAME.test(table))
    throw new TypeError(`The push device table must be a name or schema.name, not "${table}"`);

  return {
    async register({ userId, token, platform }) {
      await pool.query(
        `INSERT INTO ${table} (token, user_id, platform) VALUES ($1, $2, $3)
          ON CONFLICT (token) DO UPDATE
          SET user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now()`,
        [token, userId, platform],
      );
    },

    async unregister(userId, token) {
      await pool.query(`DELETE FROM ${table} WHERE token = $1 AND user_id = $2`, [token, userId]);
    },

    async listForUser(userId) {
      const { rows } = await pool.query<{ token: string; platform: string }>(
        `SELECT token, platform FROM ${table} WHERE user_id = $1`,
        [userId],
      );
      // The table's CHECK allows only these two. A row from another writer that slipped past it is
      // skipped rather than sent through a transport that would call the token dead.
      const devices: PushDevice[] = [];
      for (const { token, platform } of rows)
        if (platform === "ios" || platform === "android") devices.push({ token, platform });
      return devices;
    },

    async remove(token) {
      await pool.query(`DELETE FROM ${table} WHERE token = $1`, [token]);
    },
  };
}
