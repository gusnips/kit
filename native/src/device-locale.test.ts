import { describe, expect, it } from "vitest";
import { pickDeviceLocale } from "./device-locale.ts";

// The same table `matchLocale` in @gusnips/locale is held to, so a phone and a browser with the
// same languages land on the same one.
describe("pickDeviceLocale", () => {
  const SHIPPED = ["en", "pt-BR", "es"];

  it("walks the phone's list in its own order", () => {
    expect(pickDeviceLocale(["es", "en"], SHIPPED)).toBe("es");
    // i18next's matcher answers English here: an exact match anywhere beats a base subtag.
    expect(pickDeviceLocale(["pt-PT", "en"], SHIPPED)).toBe("pt-BR");
    expect(pickDeviceLocale(["pt"], SHIPPED)).toBe("pt-BR");
    expect(pickDeviceLocale(["PT-br"], SHIPPED)).toBe("pt-BR");
    expect(pickDeviceLocale(["de", "es-MX"], SHIPPED)).toBe("es");
  });

  it("looks past the first language, which the donor did not", () => {
    expect(pickDeviceLocale(["fr-FR", "en-US"], SHIPPED)).toBe("en");
  });

  it("answers null when nothing matches, so i18next's fallback applies", () => {
    expect(pickDeviceLocale(["de", "fr"], SHIPPED)).toBeNull();
    expect(pickDeviceLocale(["", " "], SHIPPED)).toBeNull();
    expect(pickDeviceLocale([], SHIPPED)).toBeNull();
  });

  it("takes an exact tag over an earlier language that only shares its base", () => {
    const both = ["pt-BR", "pt-PT"];
    expect(pickDeviceLocale(["pt-PT"], both)).toBe("pt-PT");
    expect(pickDeviceLocale(["pt"], both)).toBe("pt-BR");
  });
});
