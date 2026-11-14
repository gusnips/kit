import { describe, expect, it } from "vitest";
import { isBrokenLightningcss } from "./css.ts";

describe("isBrokenLightningcss", () => {
  it("lets 1.30.1 and earlier through", () => {
    for (const version of ["1.30.1", "1.30.0", "1.29.3", "1.0.0", "0.9.9"])
      expect(isBrokenLightningcss(version), version).toBe(false);
  });

  it("refuses every release after 1.30.1, the measured ones included", () => {
    for (const version of ["1.30.2", "1.30.10", "1.31.0", "1.32.0", "1.33.0", "2.0.0"])
      expect(isBrokenLightningcss(version), version).toBe(true);
  });

  it("reads a prerelease or build suffix by its numbers", () => {
    expect(isBrokenLightningcss("1.30.1-beta.2")).toBe(false);
    expect(isBrokenLightningcss("1.30.2+build.7")).toBe(true);
  });
});
