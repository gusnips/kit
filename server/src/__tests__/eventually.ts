/** Polls `check` every 20 ms until it holds, and throws once `ms` pass without it. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`still false after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
