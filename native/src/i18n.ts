/**
 * The app's language on a phone: the one the person picked, else the phone's own, else your
 * fallback.
 *
 * The detector reads the phone's languages with react-native-localize, synchronously, so the first
 * render is already in a real language. A choice saved earlier is read from AsyncStorage after
 * that (`restore`), and wins.
 *
 * **Only `choose` writes the saved choice.** i18next calls a detector's `cacheUserLanguage` on
 * EVERY language change, the one it detected at launch included. The donor's detector saved there,
 * so the first launch saved the phone's language as though the person had picked it, and when they
 * later switched the phone to another language the app stayed in the old one for good. That is
 * `storageWriter: "app"` in `@gusnips/react`'s `i18nInitOptions`, the same lesson from the web: one
 * writer per key, and here the writer is your language control.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { i18n as I18n, LanguageDetectorModule } from "i18next";
import { getLocales } from "react-native-localize";
import { pickDeviceLocale } from "./device-locale.ts";

export interface NativeLanguageOptions {
  /** Every language this app ships, as the exact tags its catalogs use. */
  supported: readonly string[];
  /** The AsyncStorage key holding the person's choice. Keep the key your app already uses. */
  storageKey: string;
}

export interface NativeLanguage {
  /** Hand to `i18n.use()` before `init`. */
  detector: LanguageDetectorModule;
  /** Apply the saved choice, if there is one. Call once at launch, after `init`. */
  restore(): Promise<void>;
  /**
   * The person picked a language: switch to it and remember it. `null` means "follow the phone":
   * forget the choice and switch to what the phone asks for.
   */
  choose(language: string | null): Promise<void>;
}

/**
 * ```ts
 * import i18n from "i18next";
 *
 * export const language = createNativeLanguage(i18n, {
 *   supported: ["pt-BR", "en"],
 *   storageKey: "app:language",
 * });
 * i18n.use(language.detector).use(initReactI18next).init({ resources, fallbackLng: "pt-BR" });
 * ```
 *
 * A phone whose languages are none of `supported` gets `fallbackLng`: the detector answers nothing
 * and i18next falls back on its own.
 */
export function createNativeLanguage(i18n: I18n, options: NativeLanguageOptions): NativeLanguage {
  const { supported, storageKey } = options;
  // A choice made while the saved one is still loading wins over it.
  let chosen = false;

  const fromDevice = () =>
    pickDeviceLocale(
      getLocales().map((locale) => locale.languageTag),
      supported,
    ) ?? undefined;

  const detector: LanguageDetectorModule = {
    type: "languageDetector",
    init: () => {},
    detect: fromDevice,
    // Deliberately empty. See the top of this file.
    cacheUserLanguage: () => {},
  };

  async function restore(): Promise<void> {
    const stored = await AsyncStorage.getItem(storageKey).catch(() => null);
    if (chosen || stored === null || !supported.includes(stored)) return;
    if (i18n.language !== stored) await i18n.changeLanguage(stored);
  }

  async function choose(language: string | null): Promise<void> {
    chosen = true;
    const write =
      language === null
        ? AsyncStorage.removeItem(storageKey)
        : AsyncStorage.setItem(storageKey, language);
    // Not remembered across launches when storage fails, and still applied for this one.
    await write.catch(() => {});
    await i18n.changeLanguage(language ?? fromDevice());
  }

  return { detector, restore, choose };
}
