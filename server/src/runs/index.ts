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
 *   fix it shipped was letting the second run use free data only. Here the checkpoint and the
 *   spend live on the rows, so a resumed run goes on from its checkpoint with its spend counted.
 * - **A finished child is never paid for twice.** A child is a row kept under its parent and a key,
 *   so a resumed parent that asks for a child it already ran gets the stored result back.
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

/** Caps for a whole tree: the root and every child under it, across restarts. */
export interface RunLimits {
  /**
   * How many children run at once. A child waiting on its own children lends its place out while
   * it waits, so a deep tree can never wait on itself.
   */
  maxParallel?: number;
  /** How many children the tree may start in all. */
  maxChildren?: number;
  /** How deep children may nest: the root is depth 0, its children depth 1. */
  maxDepth?: number;
  /**
   * What the tree may spend, in US dollars, as counted by `run.spend`. Past it a new child is
   * refused; work that already started goes on.
   */
  budgetUsd?: number;
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
  limits?: RunLimits;
}

/** A child run. Its code is the function passed to `run.child`. */
export interface ChildSpec {
  /** A label for the child's row, such as `"search"`. */
  kind: string;
  /** What the child's function reads as `run.input`. Stored as JSON. */
  input: unknown;
  /** What happens to the child when its worker dies. Default: the root's policy. */
  restart?: RestartPolicy;
}

/**
 * How a child ended. `value` is what its function returned, read back from the row, so it is the
 * same JSON on the first run and after a restart. `error.code` is `handler` (its function threw),
 * `interrupted` (its worker died and its `restart` is `fail`), `cancelled`, or a limit that refused
 * it before it started: `max_depth`, `max_children` or `budget`.
 */
export type ChildResult<T> = { ok: true; value: T } | { ok: false; error: RunError };

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
   * Adds `usd` to what this run has spent, for the tree's `budgetUsd`. The total outlives a
   * restart. Throws once the run is lost.
   */
  spend(usd: number): Promise<void>;
  /**
   * Runs `fn` as a child, kept under `key` among this run's children. A child that already
   * finished, in this attempt or one before a restart, does not run again: `child` returns what it
   * stored. A child its dead worker left unfinished goes by its own `restart`. Children run in
   * this process, under this run's lease. Throws once the run is lost, and when this run already
   * has a child running under `key`.
   */
  child<T>(key: string, spec: ChildSpec, fn: (run: Run) => Promise<T>): Promise<ChildResult<T>>;
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
const LIMIT_NAMES = ["maxParallel", "maxChildren", "maxDepth", "budgetUsd"] as const;
/** ponytail: a tail polls once a second, so the last event can be a second late. LISTEN/NOTIFY
 *  is the upgrade, at the cost of a connection held per tail. */
const TAIL_POLL_MS = 1_000;
const TAIL_PAGE = 100;

/** What a handler's `run` is made from. */
interface RunRow {
  input: unknown;
  checkpoint: unknown;
  resumed: boolean;
  crashes: number;
}

interface ClaimedRow extends RunRow {
  kind: string;
  owner: string;
  limits: RunLimits;
  /** Children the tree started, and what it spent, in every attempt so far. */
  children: number;
  spent: number;
}

/** One lease, held by one worker, over a root and everything under it. */
interface Tree {
  rootId: string;
  token: string;
  owner: string;
  controller: AbortController;
  limits: RunLimits;
  children: number;
  spent: number;
  slots?: Slots;
}

/** One run in a tree, with its own event sequence. */
interface Node {
  id: string;
  depth: number;
  seq: number;
  appends: Promise<void>;
  /** The keys of its children running now. */
  keys: Set<string>;
  /** Its `maxParallel` slot: wanted while its function runs and waits on no child of its own. */
  busy: boolean;
  waiting: number;
  slot: "none" | "asking" | "held";
}

/** The tree's `maxParallel` places. */
interface Slots {
  free: number;
  queue: (() => void)[];
}

interface FoundChild<T> {
  id: string;
  status: RunStatus;
  result: T;
  error: RunError | null;
}

type Attempt = { ok: true; value: unknown } | { ok: false; error: unknown };

/** How a run ends, as its row keeps it. */
interface Verdict {
  status: "succeeded" | "failed" | "cancelled";
  result: string | null;
  error: RunError | null;
}

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

  const createSql = `INSERT INTO ${runs} (id, root_id, kind, owner, restart, input, max_crashes,
      limits)
    VALUES ($1, $1, $2, $3, $4, $5::json, $6, $7::json)`;

  // A queued row, or a running one whose lease ran out and whose policy lets it go on. Taking over
  // a lease counts a crash; claiming a row a drain put back does not. `prev` reads the row under
  // the same lock, as it was before this claim. The tree's totals come with it, for its limits.
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
    RETURNING c.kind, c.owner, c.input, c.crashes, prev.resumed, c.limits,
      CASE WHEN c.restart = 'resume' THEN c.checkpoint END AS checkpoint,
      (SELECT count(*)::int FROM ${runs} k WHERE k.root_id = c.id AND k.id <> c.id) AS children,
      (SELECT coalesce(sum(k.cost_usd), 0)::float8 FROM ${runs} k WHERE k.root_id = c.id) AS spent`;
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
  const rootHeld = `EXISTS (SELECT 1 FROM ${runs} r
    WHERE r.id = $2 AND r.lease_token = $3 AND r.status = 'running' FOR SHARE)`;
  const heldChild = `c.id = $1 AND c.root_id = $2 AND c.status = 'running' AND ${rootHeld}`;
  /** One UPDATE, fenced either way: `[$1 run, $2 root, $3 token, ...]`. */
  const fenced = (set: string) => ({
    root: `UPDATE ${runs} c SET ${set}, updated_at = now() WHERE ${heldRoot}`,
    child: `UPDATE ${runs} c SET ${set}, updated_at = now() WHERE ${heldChild}`,
  });
  const saveSql = fenced("checkpoint = $4::json");
  const spendSql = fenced("cost_usd = c.cost_usd + $4");
  const appendSql = `INSERT INTO ${events} (run_id, seq, type, data)
    SELECT $1::uuid, $4::int, $5::text, $6::json FROM ${runs} r
    WHERE r.id = $2 AND r.lease_token = $3 AND r.status = 'running' FOR SHARE`;

  const findChildSql = `SELECT id, status, result, error FROM ${runs}
    WHERE parent_id = $1 AND child_key = $2`;
  const addChildSql = `INSERT INTO ${runs} (id, root_id, parent_id, child_key, depth, kind, owner,
      status, restart, input, max_crashes, lease_token, started_at)
    SELECT $1, r.id, $4, $5, $6, $7, r.owner, 'running', coalesce($8, r.restart), $9::json,
      r.max_crashes, r.lease_token, now()
    FROM ${runs} r WHERE r.id = $2 AND r.lease_token = $3 AND r.status = 'running' FOR SHARE`;
  // A child its dead worker left unfinished, or one a drain put back. Its `restart` decides.
  const takeChildSql = `UPDATE ${runs} c SET status = 'running', lease_token = $3,
      crashes = c.crashes + (c.status = 'running')::int, updated_at = now()
    WHERE c.id = $1 AND c.root_id = $2 AND c.status IN ('queued', 'running')
      AND (c.restart <> 'fail' OR c.status = 'queued') AND ${rootHeld}
    RETURNING c.crashes, CASE WHEN c.restart = 'resume' THEN c.checkpoint END AS checkpoint`;
  const endChildSql = `WITH done AS (
      UPDATE ${runs} c SET status = $4, result = $5::json, error = $6::json, lease_token = NULL,
        finished_at = now(), updated_at = now()
      WHERE ${heldChild} RETURNING c.id, c.status, c.result, c.error),
    ended AS (INSERT INTO ${events} (run_id, seq, type, data)
      SELECT id, $7, 'end', json_build_object('status', status, 'error', error) FROM done)
    SELECT result FROM done`;

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

  // A queued run ends now. A running one is flagged, and its worker stops it at its next heartbeat.
  const cancelQueuedSql = closeTree(`UPDATE ${runs} SET status = 'cancelled',
      cancel_requested_at = now(), finished_at = now(), updated_at = now()
    WHERE id = $1 AND parent_id IS NULL AND status = 'queued'`);
  const cancelRunningSql = `UPDATE ${runs} SET cancel_requested_at = coalesce(cancel_requested_at,
      now()), updated_at = now()
    WHERE id = $1 AND parent_id IS NULL AND status = 'running'`;

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

  /** One fenced write by `node`. A write the fence refuses aborts the tree and throws `lost`. */
  async function write(
    tree: Tree,
    node: Node,
    sql: { root: string; child: string },
    value: unknown,
  ): Promise<void> {
    const { signal } = tree.controller;
    if (stopCode(signal) === "lost") throw signal.reason;
    const { rowCount } = await pool.query(node.depth === 0 ? sql.root : sql.child, [
      node.id,
      tree.rootId,
      tree.token,
      value,
    ]);
    if (rowCount !== 1) throw lose(tree);
  }

  function runOf(tree: Tree, node: Node, row: RunRow): Run {
    const { signal } = tree.controller;
    return {
      id: node.id,
      owner: tree.owner,
      input: row.input,
      checkpoint: row.checkpoint,
      resumed: row.resumed,
      crashes: row.crashes,
      signal,
      save: (state) => write(tree, node, saveSql, JSON.stringify(state) ?? null),
      async spend(usd) {
        if (!(Number.isFinite(usd) && usd >= 0))
          throw new TypeError(`spend takes a number of US dollars, 0 or more, not ${usd}`);
        await write(tree, node, spendSql, usd);
        tree.spent += usd;
      },
      child: (key, spec, fn) => runChild(tree, node, key, spec, fn),
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

  /** How a handler's outcome is kept. A failure goes to `onError` too, with its stack. */
  function verdict(signal: AbortSignal, id: string, kind: string, outcome: Attempt): Verdict {
    if (outcome.ok) {
      try {
        return { status: "succeeded", result: JSON.stringify(outcome.value) ?? null, error: null };
      } catch (cause) {
        outcome = {
          ok: false,
          error: new Error("The result could not be stored as JSON", { cause }),
        };
      }
    }
    if (stopCode(signal) === "cancelled") return { status: "cancelled", result: null, error: null };
    onError(new Error(`Run ${id} (${kind}) failed`, { cause: outcome.error }));
    return {
      status: "failed",
      result: null,
      error: { code: "handler", message: messageOf(outcome.error) },
    };
  }

  async function finish(tree: Tree, kind: string, outcome: Attempt): Promise<DriveOutcome> {
    if (stopCode(tree.controller.signal) === "lost") return "lost";
    const { status, result, error } = verdict(tree.controller.signal, tree.rootId, kind, outcome);
    const { rows } = await pool.query<{ status: "succeeded" | "failed" | "cancelled" }>(finishSql, [
      tree.rootId,
      tree.token,
      status,
      result,
      error && JSON.stringify(error),
    ]);
    const ended = rows[0];
    if (ended) return ended.status;
    // Another worker took the run over while this one wrote nothing: work it started still stops.
    lose(tree);
    return "lost";
  }

  async function runChild<T>(
    tree: Tree,
    parent: Node,
    key: string,
    spec: ChildSpec,
    fn: (run: Run) => Promise<T>,
  ): Promise<ChildResult<T>> {
    const { signal } = tree.controller;
    const stop = stopCode(signal);
    if (stop === "cancelled") return { ok: false, error: { code: "cancelled" } };
    if (stop) throw signal.reason;
    if (parent.keys.has(key))
      throw new Error(
        `Run ${parent.id} already has a child "${key}" running. Give each child its own key.`,
      );
    parent.keys.add(key);
    try {
      const found = (await pool.query<FoundChild<T>>(findChildSql, [parent.id, key])).rows[0];
      if (found?.status === "succeeded") return { ok: true, value: found.result };
      if (found?.status === "failed" || found?.status === "cancelled")
        return { ok: false, error: found.error ?? { code: "cancelled" } };

      const node = nodeOf(found?.id ?? crypto.randomUUID(), parent.depth + 1);
      let row: RunRow = { input: spec.input, checkpoint: null, resumed: false, crashes: 0 };
      if (found) {
        node.seq = (await pool.query<{ seq: number }>(lastSeqSql, [node.id])).rows[0]?.seq ?? 0;
        const taken = (
          await pool.query<{ crashes: number; checkpoint: unknown }>(takeChildSql, [
            node.id,
            tree.rootId,
            tree.token,
          ])
        ).rows[0];
        // Its restart is `fail`, or the tree is lost, which this write finds out.
        if (!taken) return await endChild<T>(tree, node, INTERRUPTED);
        row = { ...row, ...taken, resumed: true };
      } else {
        const refused = refusal(tree, node.depth);
        if (refused) return { ok: false, error: refused };
        // Counted before the insert, so children started together count each other.
        tree.children++;
        const { rowCount } = await pool.query(addChildSql, [
          node.id,
          tree.rootId,
          tree.token,
          parent.id,
          key,
          node.depth,
          spec.kind,
          spec.restart ?? null,
          JSON.stringify(spec.input ?? null),
        ]);
        if (rowCount !== 1) throw lose(tree);
      }

      const outcome = await inSlot(tree.slots, parent, node, () =>
        attempt(() => fn(runOf(tree, node, row))),
      );
      await node.appends;
      if (stopCode(signal) === "lost") throw signal.reason;
      return await endChild<T>(tree, node, verdict(signal, node.id, spec.kind, outcome));
    } finally {
      parent.keys.delete(key);
    }
  }

  /** Ends a child with its closing event, and reads its result back from the row. */
  async function endChild<T>(
    tree: Tree,
    node: Node,
    { status, result, error }: Verdict,
  ): Promise<ChildResult<T>> {
    const { rows } = await pool.query<{ result: T }>(endChildSql, [
      node.id,
      tree.rootId,
      tree.token,
      status,
      result,
      error && JSON.stringify(error),
      node.seq + 1,
    ]);
    const ended = rows[0];
    if (!ended) throw lose(tree);
    if (status === "succeeded") return { ok: true, value: ended.result };
    return { ok: false, error: error ?? { code: "cancelled" } };
  }

  return {
    /**
     * Adds a queued run and returns its id. Pass your transaction's client to create it with the
     * rest of a write, and add its job after the commit (BullMQ) or in the same transaction
     * (pg-boss), as the README shows.
     */
    async create(spec: RunSpec, client: Pick<Pool, "query"> = pool): Promise<{ id: string }> {
      const { kind, owner, input, restart = "fail", maxCrashes = 5, limits = {} } = spec;
      if (!RESTART_POLICIES.has(restart))
        throw new TypeError(`restart is "fail", "restart" or "resume", not "${restart}"`);
      if (!(Number.isInteger(maxCrashes) && maxCrashes >= 0))
        throw new TypeError(`maxCrashes is a whole number of 0 or more, not ${maxCrashes}`);
      for (const name of LIMIT_NAMES) {
        const value = limits[name];
        const least = name === "maxParallel" ? 1 : 0;
        const whole = name !== "budgetUsd";
        if (
          value !== undefined &&
          !(Number.isFinite(value) && value >= least && (!whole || Number.isInteger(value)))
        )
          throw new TypeError(
            `limits.${name} is ${whole ? "a whole number" : "a number"} of ${least} or more, ` +
              `not ${value}`,
          );
      }
      const id = crypto.randomUUID();
      await client.query(createSql, [
        id,
        kind,
        owner,
        restart,
        JSON.stringify(input ?? null),
        maxCrashes,
        JSON.stringify(limits),
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
      const { owner, limits, children, spent } = claimed;
      const tree: Tree = {
        rootId: runId,
        token,
        owner,
        controller: new AbortController(),
        limits,
        children,
        spent,
        ...(limits.maxParallel !== undefined && {
          slots: { free: limits.maxParallel, queue: [] },
        }),
      };
      const root = nodeOf(runId, 0, rows[0]?.seq);
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
     * Cancels a run and everything under it. A queued run ends at once. A running one is flagged,
     * and its worker aborts `run.signal` with code `cancelled` at its next heartbeat, within
     * `leaseSecs / 3` (10 seconds by default). A run whose worker died ends here. False when the run
     * had already finished, or does not exist.
     */
    async cancel(runId: string): Promise<boolean> {
      if ((await pool.query(cancelQueuedSql, [runId])).rows.length > 0) return true;
      if ((await pool.query(cancelRunningSql, [runId])).rowCount !== 1) return false;
      await pool.query(expireSql, [runId, 1]);
      return true;
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

const INTERRUPTED: Verdict = { status: "failed", result: null, error: { code: "interrupted" } };

/** Why the tree may not start one more child at `depth`, when it may not. */
function refusal(tree: Tree, depth: number): RunError | undefined {
  const { maxDepth, maxChildren, budgetUsd } = tree.limits;
  if (maxDepth !== undefined && depth > maxDepth)
    return {
      code: "max_depth",
      message: `A child here would be at depth ${depth}. maxDepth is ${maxDepth}.`,
    };
  if (maxChildren !== undefined && tree.children >= maxChildren)
    return {
      code: "max_children",
      message: `The tree already started ${tree.children} children. maxChildren is ${maxChildren}.`,
    };
  if (budgetUsd !== undefined && tree.spent >= budgetUsd)
    return {
      code: "budget",
      message: `The tree spent $${Number(tree.spent.toFixed(6))} of its $${budgetUsd} budget.`,
    };
  return undefined;
}

function nodeOf(id: string, depth: number, seq = 0): Node {
  return {
    id,
    depth,
    seq,
    appends: Promise.resolve(),
    keys: new Set(),
    busy: false,
    waiting: 0,
    slot: "none",
  };
}

/** Runs `work` for `node`, a child of `parent`, inside the tree's `maxParallel`. */
async function inSlot<R>(
  slots: Slots | undefined,
  parent: Node,
  node: Node,
  work: () => Promise<R>,
): Promise<R> {
  parent.waiting++;
  await fit(slots, parent);
  node.busy = true;
  await fit(slots, node);
  try {
    return await work();
  } finally {
    node.busy = false;
    await fit(slots, node);
    parent.waiting--;
    await fit(slots, parent);
  }
}

/**
 * Gives `node` a slot of the tree's `maxParallel` while its function runs and waits on no child of
 * its own, and takes it back otherwise. Call it after each change to `busy` or `waiting`. A child
 * waiting on its children lends its slot to them, so a tree can never wait on itself.
 */
async function fit(slots: Slots | undefined, node: Node): Promise<void> {
  if (!slots || node.depth === 0) return;
  const wants = () => node.busy && node.waiting === 0;
  if (wants() && node.slot === "none") {
    node.slot = "asking";
    await take(slots);
    node.slot = "held";
  }
  // Also after the wait above: it may have started a child meanwhile.
  if (!wants() && node.slot === "held") {
    node.slot = "none";
    give(slots);
  }
}

function take(slots: Slots): Promise<void> {
  if (slots.free > 0) {
    slots.free--;
    return Promise.resolve();
  }
  return new Promise((resolve) => slots.queue.push(resolve));
}

function give(slots: Slots): void {
  const next = slots.queue.shift();
  if (next) next();
  else slots.free++;
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
