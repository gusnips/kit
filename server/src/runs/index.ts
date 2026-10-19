/**
 * `@gusnips/server/runs`: agent runs that outlive the process running them.
 *
 * The row in Postgres is the truth. A queue job carries only `{ runId }`, so BullMQ and pg-boss
 * both work with no adapter, and a job delivered twice is harmless: only one worker at a time can
 * hold a run's lease, and `drive` on a run that is held or finished does nothing.
 *
 * What the donors taught:
 * - **A run whose process died must end or go on, never stay "running".** Two donors swept for
 *   such rows, one after 30 minutes and one only when its job came back, and each screen watching
 *   one waited until then. Here a lease runs out within 30 seconds and the next worker that looks
 *   takes the run over, or ends it, by the run's own `restart` policy.
 * - **Starting over is not free.** One donor ran a cut run again from the start with its spend
 *   counter back at zero, so the second run could buy past what the person had allowed, and the
 *   fix it shipped was letting the second run use free data only. Here the checkpoint lives on the
 *   row, so a resumed run goes on from it.
 * - **A screen watching a run needs a closing event.** Every way a run ends writes one, in the
 *   same statement, or a tail waits for a frame that never comes.
 * - **Appends never hold up the work, and never reorder.** `emit` returns at once; the appends run
 *   behind it one at a time, and a finish waits for them.
 * - **A late writer must not touch the run that replaced it** (invariant 57). A worker that was
 *   paused past its lease still holds its handler, and every write it tries afterwards is refused.
 *
 * `pg` is used for its types only, so this subpath installs nothing.
 */
import type { Pool } from "pg";

/** What a run does after its worker dies. See {@link RunSpec.restart}. */
export type RestartPolicy = "fail" | "restart" | "resume";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** What a failed run keeps as its `error`. */
export interface RunError {
  /**
   * `handler`: the handler threw, and `message` is what it threw. `interrupted`: its worker died
   * and its `restart` is `fail`. `restart_limit`: its worker died `maxCrashes` times.
   */
  code: string;
  message?: string;
}

export interface RunsOptions {
  /** The runs table from the README, with its schema: `app.runs`. */
  table: string;
  /** The events table from the README: `app.run_events`. */
  events: string;
  /**
   * Called with what failed without failing the run: an event that was not kept, a lease that
   * could not be renewed, and the error a handler threw (the row keeps only its message). Log it.
   * Must not throw.
   */
  onError: (error: unknown) => void;
  /**
   * How long a run is held after its worker last checked in. A run whose worker died is taken
   * over once this passes. Default and most: 30 seconds, because BullMQ re-runs the job of a dead
   * worker 35 seconds later at the earliest, and the lease must have run out by then, or the job
   * runs, finds the run held, and does nothing.
   */
  leaseSecs?: number;
}

export interface RunSpec {
  /** Which handler drives it: a key of the handlers you pass to `drive`. */
  kind: string;
  /** Whose run it is, for your own check before a tail or a cancel. This module checks nothing. */
  owner: string;
  /** What the handler reads as `run.input`. Stored as JSON. */
  input: unknown;
  /**
   * What happens when the worker running it dies (its lease runs out). `fail`, the default: it
   * ends `failed` with code `interrupted`. `restart`: it runs again from the start. `resume`: it
   * runs again from its last `save`, so whatever ran after that save runs twice. Pick `resume` only
   * for a handler that can take that.
   */
  restart?: RestartPolicy;
  /** How many times a dead worker's run is taken over before it ends `restart_limit`. Default 5. */
  maxCrashes?: number;
}

/** What a handler gets. */
export interface Run {
  readonly id: string;
  readonly owner: string;
  readonly input: unknown;
  /** The last `save` before the worker died, under `restart: "resume"`. `null` otherwise. */
  readonly checkpoint: unknown;
  /** True when this run was started before: a worker died, or a drain put it back. */
  readonly resumed: boolean;
  /** How many times a dead worker's run was taken over, this time included. */
  readonly crashes: number;
  /**
   * Aborts when the run must stop. Its `reason` is a {@link RunStopped} saying why: `lost` (another
   * worker took the run over), `cancelled` or `shutdown`. Pass it to every provider call.
   */
  readonly signal: AbortSignal;
  /** Keeps `state` as the checkpoint a resumed run starts from. Throws once the run is lost. */
  save(state: unknown): Promise<void>;
  /**
   * Appends an event for `tail`, and returns at once. Appends run in order behind it, and the run
   * does not finish before they do. One that fails goes to `onError`; it never throws.
   */
  emit(type: string, data?: unknown): void;
}

export type RunHandler = (run: Run) => Promise<unknown>;

/**
 * What one `drive` call did. `skipped`: nothing, because the run is held, finished or unknown.
 * `lost`: it started the run, and another worker took it over. `requeued`: a drain stopped it and
 * put it back in the queue. The rest: how it ended the run.
 */
export type DriveOutcome = "succeeded" | "failed" | "cancelled" | "requeued" | "lost" | "skipped";

export interface RunEvent {
  seq: number;
  type: string;
  data: unknown;
  at: Date;
}

export type StopCode = "lost" | "cancelled" | "shutdown";

const STOP_MESSAGES: Record<StopCode, string> = {
  lost: "This worker no longer holds the run: its lease ran out and the run was taken over or ended.",
  cancelled: "The run was cancelled.",
  shutdown: "The worker is shutting down.",
};

/** The reason `run.signal` aborts with. */
export class RunStopped extends Error {
  readonly code: StopCode;

  constructor(code: StopCode) {
    super(STOP_MESSAGES[code]);
    this.name = "RunStopped";
    this.code = code;
  }
}

/** A name or `schema.name`, because the table is written into the SQL, not passed as a value. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const RESTART_POLICIES = new Set<string>(["fail", "restart", "resume"]);
/** ponytail: a tail polls once a second, so the last event can be a second late. LISTEN/NOTIFY
 *  is the upgrade, at the cost of a connection held per tail. */
const TAIL_POLL_MS = 1_000;
const TAIL_PAGE = 100;

interface ClaimedRow {
  kind: string;
  owner: string;
  input: unknown;
  restart: RestartPolicy;
  crashes: number;
  resumed: boolean;
  checkpoint: unknown;
}

/** One lease, held by one worker, over a root and everything under it. */
interface Tree {
  rootId: string;
  token: string;
  controller: AbortController;
}

/** One run in a tree, with its own event sequence. */
interface Node {
  id: string;
  seq: number;
  appends: Promise<void>;
}

type Attempt = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * The runs store. Create runs with `create`, and have a queue worker call `drive` with the id:
 *
 *     const runs = createRuns(pool, {
 *       table: "app.runs",
 *       events: "app.run_events",
 *       onError: (error) => logger.error("[runs] failed", { error }),
 *     });
 */
export function createRuns(pool: Pick<Pool, "query">, options: RunsOptions) {
  const { table: runs, events, onError, leaseSecs = 30 } = options;
  for (const name of [runs, events])
    if (!TABLE_NAME.test(name))
      throw new TypeError(`A runs table must be a name or schema.name, not "${name}"`);
  if (!(leaseSecs > 0 && leaseSecs <= 30))
    throw new TypeError(
      `leaseSecs must be above 0 and at most 30, not ${leaseSecs}: BullMQ re-runs the job of a ` +
        "dead worker 35 seconds later at the earliest, and the lease must have run out by then.",
    );

  const createSql = `INSERT INTO ${runs} (id, root_id, kind, owner, restart, input, max_crashes)
    VALUES ($1, $1, $2, $3, $4, $5::json, $6)`;

  // A queued row, or a running one whose lease ran out and whose policy lets it go on. Taking over
  // a lease counts a crash; claiming a row a drain put back does not. `prev` reads the row under
  // the same lock, as it was before this claim.
  const claimSql = `WITH prev AS (
      SELECT id, started_at IS NOT NULL AS resumed FROM ${runs}
      WHERE id = $1 AND parent_id IS NULL FOR UPDATE)
    UPDATE ${runs} c SET status = 'running', lease_token = $2,
      lease_until = now() + make_interval(secs => $3),
      crashes = c.crashes + (c.status = 'running')::int,
      started_at = coalesce(c.started_at, now()), updated_at = now()
    FROM prev
    WHERE c.id = prev.id AND c.cancel_requested_at IS NULL
      AND (c.status = 'queued' OR (c.status = 'running' AND c.lease_until < now()
        AND c.restart <> 'fail' AND c.crashes < c.max_crashes))
    RETURNING c.kind, c.owner, c.input, c.restart, c.crashes, prev.resumed,
      CASE WHEN c.restart = 'resume' THEN c.checkpoint END AS checkpoint`;
  // Its own statement, after the claim: an append still in flight holds the row FOR SHARE, so the
  // claim waited for it to commit, and this read sees it.
  const lastSeqSql = `SELECT coalesce(max(seq), 0) AS seq FROM ${events} WHERE run_id = $1`;

  const heartbeatSql = `UPDATE ${runs} SET lease_until = now() + make_interval(secs => $3),
      updated_at = now()
    WHERE id = $1 AND lease_token = $2 AND status = 'running'
    RETURNING cancel_requested_at IS NOT NULL AS cancel`;

  // Every write in a tree is checked against the ROOT row's token (invariant 57), so a worker that
  // lost the lease writes nothing anywhere in the tree. A write to the root row is checked by its
  // own WHERE, which Postgres reads again after any wait. An append, or a write anywhere below the
  // root, takes the root row FOR SHARE: it commits before a takeover's claim, or not at all.
  const heldRoot = `c.id = $1 AND c.root_id = $2 AND c.lease_token = $3 AND c.status = 'running'`;
  const saveSql = `UPDATE ${runs} c SET checkpoint = $4::json, updated_at = now() WHERE ${heldRoot}`;
  const appendSql = `INSERT INTO ${events} (run_id, seq, type, data)
    SELECT $1::uuid, $4::int, $5::text, $6::json FROM ${runs} r
    WHERE r.id = $2 AND r.lease_token = $3 AND r.status = 'running' FOR SHARE`;

  // What every way of ending a root shares. Whatever is still open below it ends too: cancelled
  // under a cancelled root, interrupted otherwise. Each run that ended gets its closing event in
  // the same statement, so a tail that reads a run as finished finds the closing event too.
  const closeTree = (endRoot: string) => `WITH root AS (${endRoot} RETURNING id, status, error),
    kids AS (
      UPDATE ${runs} c SET
        status = CASE WHEN root.status = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
        error = CASE WHEN root.status = 'cancelled' THEN NULL
          ELSE '{"code":"interrupted"}'::json END,
        lease_token = NULL, finished_at = now(), updated_at = now()
      FROM root WHERE c.root_id = root.id AND c.id <> root.id AND c.status IN ('queued', 'running')
      RETURNING c.id, c.status, c.error),
    closed AS (SELECT id, status, error FROM root UNION ALL SELECT id, status, error FROM kids),
    ended AS (INSERT INTO ${events} (run_id, seq, type, data)
      SELECT id, (SELECT coalesce(max(seq), 0) + 1 FROM ${events} e WHERE e.run_id = closed.id),
        'end', json_build_object('status', status, 'error', error)
      FROM closed)
    SELECT id, status FROM root`;
  // A cancel that landed after the last heartbeat still wins over a failure, never over a success:
  // a run that finished its work keeps it.
  const finishSql = closeTree(`UPDATE ${runs} SET
      status = CASE WHEN $3::text = 'failed' AND cancel_requested_at IS NOT NULL
        THEN 'cancelled' ELSE $3::text END,
      result = $4::json,
      error = CASE WHEN $3::text = 'failed' AND cancel_requested_at IS NOT NULL
        THEN NULL ELSE $5::json END,
      lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
    WHERE id = $1 AND lease_token = $2 AND status = 'running'`);
  // A root whose lease ran out and whose policy ends it: `fail`, out of crashes, or cancelled.
  const expireSql = closeTree(`UPDATE ${runs} SET
      status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,
      error = CASE WHEN cancel_requested_at IS NOT NULL THEN NULL
        WHEN restart = 'fail' THEN '{"code":"interrupted"}'::json
        ELSE '{"code":"restart_limit"}'::json END,
      lease_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
    WHERE id IN (SELECT id FROM ${runs}
      WHERE ($1::uuid IS NULL OR id = $1) AND parent_id IS NULL AND status = 'running'
        AND lease_until < now()
        AND (restart = 'fail' OR crashes >= max_crashes OR cancel_requested_at IS NOT NULL)
      ORDER BY lease_until LIMIT $2 FOR UPDATE)`);

  const stateSql = `SELECT status IN ('succeeded', 'failed', 'cancelled') AS finished
    FROM ${runs} WHERE id = $1`;
  const readSql = `SELECT seq, type, data, at FROM ${events}
    WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`;

  /** Aborts the tree with `lost`, and returns the error a refused write throws. */
  function lose(tree: Tree): RunStopped {
    const lost = new RunStopped("lost");
    if (!tree.controller.signal.aborted) tree.controller.abort(lost);
    return lost;
  }

  /** Extends the lease every leaseSecs/3, and reads the cancel flag while it is there. */
  function holdLease(tree: Tree): () => void {
    const everyMs = (leaseSecs * 1000) / 3;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = async () => {
      try {
        const { rows } = await pool.query<{ cancel: boolean }>(heartbeatSql, [
          tree.rootId,
          tree.token,
          leaseSecs,
        ]);
        const held = rows[0];
        if (!held) {
          lose(tree);
          return;
        }
        if (held.cancel && !tree.controller.signal.aborted)
          tree.controller.abort(new RunStopped("cancelled"));
      } catch (cause) {
        onError(new Error(`The lease on run ${tree.rootId} could not be renewed`, { cause }));
      }
      if (!stopped) timer = setTimeout(beat, everyMs);
    };
    timer = setTimeout(beat, everyMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  function runOf(tree: Tree, node: Node, row: ClaimedRow): Run {
    const { signal } = tree.controller;
    return {
      id: node.id,
      owner: row.owner,
      input: row.input,
      checkpoint: row.checkpoint,
      resumed: row.resumed,
      crashes: row.crashes,
      signal,
      async save(state) {
        if (stopCode(signal) === "lost") throw signal.reason;
        const { rowCount } = await pool.query(saveSql, [
          node.id,
          tree.rootId,
          tree.token,
          JSON.stringify(state) ?? null,
        ]);
        if (rowCount !== 1) throw lose(tree);
      },
      emit(type, data) {
        let text: string | null;
        try {
          text = JSON.stringify(data) ?? null;
        } catch (cause) {
          onError(new Error(`The "${type}" event of run ${node.id} is not JSON`, { cause }));
          return;
        }
        const seq = ++node.seq;
        node.appends = node.appends
          .then(async () => {
            if (stopCode(signal) === "lost") return;
            const appended = await pool.query(appendSql, [
              node.id,
              tree.rootId,
              tree.token,
              seq,
              type,
              text,
            ]);
            if (appended.rowCount !== 1) lose(tree);
          })
          .catch((cause: unknown) =>
            onError(
              new Error(`Event ${seq} ("${type}") of run ${node.id} was not kept`, { cause }),
            ),
          );
      },
    };
  }

  async function finish(tree: Tree, kind: string, outcome: Attempt): Promise<DriveOutcome> {
    const stop = stopCode(tree.controller.signal);
    if (stop === "lost") return "lost";
    let result: string | null = null;
    if (outcome.ok) {
      try {
        result = JSON.stringify(outcome.value) ?? null;
      } catch (cause) {
        outcome = {
          ok: false,
          error: new Error("The result could not be stored as JSON", { cause }),
        };
      }
    }
    if (!outcome.ok && stop !== "cancelled")
      onError(new Error(`Run ${tree.rootId} (${kind}) failed`, { cause: outcome.error }));
    const error: RunError | null = outcome.ok
      ? null
      : { code: "handler", message: messageOf(outcome.error) };
    const { rows } = await pool.query<{ status: "succeeded" | "failed" | "cancelled" }>(finishSql, [
      tree.rootId,
      tree.token,
      outcome.ok ? "succeeded" : "failed",
      result,
      error && JSON.stringify(error),
    ]);
    const ended = rows[0];
    if (ended) return ended.status;
    // Another worker took the run over while this one wrote nothing: work it started still stops.
    lose(tree);
    return "lost";
  }

  return {
    /**
     * Adds a queued run and returns its id. Pass your transaction's client to create it with the
     * rest of a write, and add its job after the commit (BullMQ) or in the same transaction
     * (pg-boss), as the README shows.
     */
    async create(spec: RunSpec, client: Pick<Pool, "query"> = pool): Promise<{ id: string }> {
      const { kind, owner, input, restart = "fail", maxCrashes = 5 } = spec;
      if (!RESTART_POLICIES.has(restart))
        throw new TypeError(`restart is "fail", "restart" or "resume", not "${restart}"`);
      if (!(Number.isInteger(maxCrashes) && maxCrashes >= 0))
        throw new TypeError(`maxCrashes is a whole number of 0 or more, not ${maxCrashes}`);
      const id = crypto.randomUUID();
      await client.query(createSql, [
        id,
        kind,
        owner,
        restart,
        JSON.stringify(input ?? null),
        maxCrashes,
      ]);
      return { id };
    },

    /**
     * Claims the run, runs its handler, and records how it ended. The one line a queue worker
     * needs. Throws only when the database fails, so a queue's retry is one more try at this, and a
     * job delivered twice finds the run held or finished and does nothing.
     */
    async drive(
      runId: string,
      handlers: Readonly<Record<string, RunHandler>>,
    ): Promise<DriveOutcome> {
      const token = crypto.randomUUID();
      const claimed = (await pool.query<ClaimedRow>(claimSql, [runId, token, leaseSecs])).rows[0];
      if (!claimed) {
        // Held by a live worker, finished, or a dead worker's run whose policy ends it here.
        const { rows } = await pool.query<{ status: "failed" | "cancelled" }>(expireSql, [
          runId,
          1,
        ]);
        return rows[0]?.status ?? "skipped";
      }
      const { rows } = await pool.query<{ seq: number }>(lastSeqSql, [runId]);
      const tree: Tree = { rootId: runId, token, controller: new AbortController() };
      const root: Node = { id: runId, seq: rows[0]?.seq ?? 0, appends: Promise.resolve() };
      const release = holdLease(tree);
      try {
        const handler = Object.hasOwn(handlers, claimed.kind) ? handlers[claimed.kind] : undefined;
        const outcome = await attempt(() => {
          if (!handler)
            throw new Error(
              `No handler for kind "${claimed.kind}". Add it to the handlers passed to drive.`,
            );
          return handler(runOf(tree, root, claimed));
        });
        await root.appends;
        return await finish(tree, claimed.kind, outcome);
      } finally {
        release();
      }
    },

    /**
     * The run's events after `afterSeq`, oldest first, then each new one as it lands, until the
     * run finishes or `signal` aborts. For a Server-Sent Events stream, send each `seq` as the
     * event's id, and pass the client's `Last-Event-ID` back here as `afterSeq`.
     */
    async *tail(
      runId: string,
      afterSeq = 0,
      signal?: AbortSignal,
    ): AsyncGenerator<RunEvent, void, undefined> {
      if (!(Number.isInteger(afterSeq) && afterSeq >= 0))
        throw new TypeError(`afterSeq is a whole number of 0 or more, not ${afterSeq}`);
      let after = afterSeq;
      while (!signal?.aborted) {
        // The state first: a run that reads finished already has its closing event, so the read
        // after it is the last one that can find anything new.
        const state = (await pool.query<{ finished: boolean }>(stateSql, [runId])).rows[0];
        const { rows } = await pool.query<RunEvent>(readSql, [runId, after, TAIL_PAGE]);
        for (const event of rows) {
          yield event;
          after = event.seq;
        }
        if (rows.length === TAIL_PAGE) continue;
        if (!state || state.finished) return;
        await sleep(TAIL_POLL_MS, signal);
      }
    },
  };
}

function stopCode(signal: AbortSignal): StopCode | undefined {
  return signal.aborted && signal.reason instanceof RunStopped ? signal.reason.code : undefined;
}

async function attempt(work: () => Promise<unknown>): Promise<Attempt> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
