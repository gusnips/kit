/**
 * The language we ship that the phone's list asks for first, or `null` when none of them is one.
 *
 * Walk the phone's list in ITS order, and for each tag take an exact match (any case), then a
 * language with the same base subtag. So a phone set to `["pt-PT", "en-US"]` gets our `pt-BR`: the
 * person put Portuguese first. The donor looked at the first tag only, so a phone on
 * `["fr-FR", "en-US"]` got the fallback instead of the English the person also reads.
 *
 * This is `matchLocale` from `@gusnips/locale`, written again because that package is a leaf
 * nothing in this repo depends on (AGENTS.md says why). `@gusnips/react`'s `i18nInitOptions` keeps
 * a third copy. The test holds this one to the same table, so a reader lands on one language
 * whichever road they come in by.
 */
export function pickDeviceLocale(
  deviceTags: readonly string[],
  supported: readonly string[],
): string | null {
  for (const tag of deviceTags) {
    const lower = tag.trim().toLowerCase();
    if (lower === "") continue;
    const base = lower.split("-")[0];
    const found =
      supported.find((lng) => lng.toLowerCase() === lower) ??
      supported.find((lng) => lng.split("-")[0]?.toLowerCase() === base);
    if (found !== undefined) return found;
  }
  return null;
}
