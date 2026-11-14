import { SourceMap } from "node:module";
import { describe, expect, it } from "vitest";
import { parseHermesErrors, toSource } from "./hermes.ts";

const STDERR = `/tmp/w/index.bundle:3:9: error: async generators are unsupported
async function* walk() {}
        ^
/tmp/w/index.bundle:7:11: error: Invalid regular expression: Invalid flags
Emitted 2 errors. exiting.
`;

// Bundle line 3, column 9 comes from src/walk.ts line 12, column 9. Column 1 of that line maps to
// column 5, so the lookup has to pick the segment the error sits in.
const MAP = new SourceMap({
  version: 3,
  file: "index.bundle",
  sources: ["/app/src/walk.ts"],
  sourcesContent: [],
  sourceRoot: "",
  names: [],
  mappings: ";;AAWI,QAAI",
});

// Code Metro generates before any module (the prelude, a JSON module) has segments with no source.
const GENERATED = new SourceMap({
  version: 3,
  file: "index.bundle",
  sources: [],
  sourcesContent: [],
  sourceRoot: "",
  names: [],
  mappings: "A",
});

describe("parseHermesErrors", () => {
  it("reads every error line and skips the source and caret lines", () => {
    expect(parseHermesErrors(STDERR)).toEqual([
      { message: "async generators are unsupported", line: 3, column: 9 },
      { message: "Invalid regular expression: Invalid flags", line: 7, column: 11 },
    ]);
  });

  it("finds nothing in a clean run", () => {
    expect(parseHermesErrors("")).toEqual([]);
  });
});

describe("toSource", () => {
  it("points a bundle position at the app's own file, 1-based", () => {
    const where = toSource(
      { message: "async generators are unsupported", line: 3, column: 9 },
      MAP,
      "/app",
      "/tmp/w/index.bundle",
    );
    expect(where).toEqual({
      message: "async generators are unsupported",
      file: "src/walk.ts",
      line: 12,
      column: 9,
    });
  });

  it("keeps the bundle position on a line Metro generated", () => {
    const where = toSource(
      { message: "x", line: 1, column: 1 },
      GENERATED,
      "/app",
      "/tmp/w/index.bundle",
    );
    expect(where).toEqual({ message: "x", file: "/tmp/w/index.bundle", line: 1, column: 1 });
  });

  it("keeps the bundle position when the map does not cover it", () => {
    const where = toSource(
      { message: "x", line: 40, column: 1 },
      MAP,
      "/app",
      "/tmp/w/index.bundle",
    );
    expect(where).toEqual({ message: "x", file: "/tmp/w/index.bundle", line: 40, column: 1 });
  });
});
