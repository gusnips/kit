import type { PushAttempt, PushSendResult } from "./types.ts";

/** One attempt, from the answer it got, timed from `startedAt` to now. */
export function attemptOf(
  answer: PushSendResult | { status: "wrong-environment" },
  startedAt: number,
  where: Pick<PushAttempt, "environment" | "httpStatus"> = {},
): PushAttempt {
  return {
    ...where,
    result: answer.status,
    ...(answer.status === "failed" ? { reason: answer.reason } : {}),
    startedAt,
    // ponytail: the wall clock, so a jump in the box's time skews one duration. A request is
    // milliseconds to seconds long, and one clock keeps `startedAt + durationMs` a real end.
    durationMs: Date.now() - startedAt,
  };
}

/** A send that failed with no answer to read: its key would not sign, or it threw. */
export function failedSend(reason: string, startedAt: number): PushSendResult {
  const result: PushSendResult = { status: "failed", reason };
  return { ...result, attempts: [attemptOf(result, startedAt)] };
}
