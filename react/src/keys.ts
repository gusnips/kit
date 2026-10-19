import { useSyncExternalStore } from "react";

/**
 * A new API key, the one time the server sends its secret. Three products wrote this flow, and
 * each knew one part the others missed:
 *
 * - One kept unread secrets in a list outside the page, so a second key did not overwrite the
 *   first and a trip to the docs did not lose either. The tab asked before closing only while one
 *   was unread, and signing out forgot them all.
 * - One kept the secret out of the list cache, folding only the record into it.
 * - None kept it out of react-query's MUTATION cache. Each `mutationFn` resolved the whole answer,
 *   secret included, so `mutation.data` held it, one of them under a comment promising it did not.
 *
 * So `create` takes the secret here and resolves only the record, and the request is the caller's.
 * Forms, permissions, list queries, invalidation and copy feedback stay in the product.
 */

/** What your create request resolves: the record your list shows, and the secret beside it. */
export interface RevealedKey<Record> {
  readonly record: Record;
  readonly key: string;
}

/** The account or workspace changed while a create or revoke was in flight. */
export class KeyScopeChangedError extends Error {
  readonly operation: "create" | "revoke";

  constructor(operation: "create" | "revoke") {
    super(
      operation === "create"
        ? "The account or workspace changed before the new key could be shown. If nobody saved it, revoke it from that workspace's keys."
        : "The account or workspace changed while the key was being revoked. Check that workspace's keys to see whether it worked.",
    );
    this.name = "KeyScopeChangedError";
    this.operation = operation;
  }
}

export interface KeyLifecycle<Record> {
  /**
   * Who and where keys are made for: the signed-in account and the workspace, joined into one
   * string, or `null` once signed out. Call it from your auth and workspace subscription, never
   * from the keys page, which may not be mounted. A new scope forgets every unread secret and
   * rejects requests started under the old one, including when the same account signs back in.
   */
  setScope(scope: string | null): void;
  /**
   * Run your create request, keep its secret here, and resolve only the record. Use it as a
   * `mutationFn`: neither the result nor the variables carry the secret, and the reveal still
   * lands when the page that asked has unmounted.
   */
  create(request: () => Promise<RevealedKey<Record>>): Promise<Record>;
  /** Run your revoke request. Only a success, in the same scope, forgets that key's secret. */
  revoke(id: string, request: () => Promise<unknown>): Promise<void>;
  /** The person saved it. Wire this to "Done", never to a copy: a copy can fail. */
  dismiss(id: string): void;
  /** Unread secrets, newest first. */
  getSnapshot(): readonly RevealedKey<Record>[];
  subscribe(listener: () => void): () => void;
}

/**
 * One per app, created at module scope, outside every route. Memory only: never storage, the URL
 * or a query cache, so a reload loses an unread secret, and the tab asks before closing while one
 * is unread. The listener comes and goes with the secrets because a page with a `beforeunload`
 * listener is kept out of some browsers' back-forward cache.
 */
export function createKeyLifecycle<Record extends { readonly id: string }>(): KeyLifecycle<Record> {
  let revealed: readonly RevealedKey<Record>[] = [];
  let scope: string | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  // Per instance, so two lifecycles never remove each other's prompt.
  function askBeforeLeaving(event: BeforeUnloadEvent): void {
    event.preventDefault();
    // Older Chrome and Safari prompt only when this is set too. The browser picks the words.
    event.returnValue = "";
  }

  function publish(next: readonly RevealedKey<Record>[]): void {
    const wasUnread = revealed.length > 0;
    revealed = next;
    if (wasUnread !== next.length > 0 && typeof window !== "undefined") {
      if (next.length > 0) window.addEventListener("beforeunload", askBeforeLeaving);
      else window.removeEventListener("beforeunload", askBeforeLeaving);
    }
    for (const listener of listeners) listener();
  }

  /** Runs `request` under the current scope and refuses an answer that outlived it. */
  async function scoped<T>(operation: "create" | "revoke", request: () => Promise<T>): Promise<T> {
    if (scope === null)
      throw new Error("Call setScope with the signed-in account and workspace first.");
    const started = generation;
    const answer = await request();
    if (started !== generation) throw new KeyScopeChangedError(operation);
    return answer;
  }

  function dismiss(id: string): void {
    const next = revealed.filter((one) => one.record.id !== id);
    if (next.length !== revealed.length) publish(next);
  }

  return {
    setScope(next) {
      if (scope === next) return;
      scope = next;
      generation++;
      if (revealed.length > 0) publish([]);
    },
    async create(request) {
      const { record, key } = await scoped("create", request);
      // The record goes on to react-query and often into the list cache. A request that passed
      // the whole answer as the record would put the secret there, which is the bug this exists
      // to end, so say so on the first try instead.
      if (JSON.stringify(record).includes(key))
        throw new Error("The record still holds the secret. Resolve it without the key field.");
      publish([{ record, key }, ...revealed]);
      return record;
    },
    async revoke(id, request) {
      await scoped("revoke", request);
      dismiss(id);
    },
    dismiss,
    getSnapshot: () => revealed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// The server has no unread secrets, and a prerender must never print one.
const none: readonly never[] = [];

/** Unread secrets, newest first. Unmounting the component forgets nothing. */
export function useKeyReveals<Record>(
  lifecycle: KeyLifecycle<Record>,
): readonly RevealedKey<Record>[] {
  return useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, () => none);
}
