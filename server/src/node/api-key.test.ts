import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApiKeyCodec } from "./api-key.ts";

const { generateApiKey, hashApiKey, displayPrefix, looksLikeApiKey, isWellFormedApiKey } =
  createApiKeyCodec({ prefix: "ac_" });

describe("createApiKeyCodec", () => {
  it("mints the prefix and 32 lowercase hex characters, never the same twice", () => {
    const keys = Array.from({ length: 500 }, generateApiKey);
    expect(new Set(keys).size).toBe(500);
    for (const key of keys) {
      expect(key).toMatch(/^ac_[0-9a-f]{32}$/);
      expect(isWellFormedApiKey(key)).toBe(true);
      expect(looksLikeApiKey(key)).toBe(true);
    }
  });

  it("hashes a key minted before the kit to the bytes already stored", () => {
    // Computed outside this code with `printf %s <key> | shasum -a 256`. A change here would
    // orphan every stored key.
    const stored = "ac_0123456789abcdef0123456789abcdef";
    expect(isWellFormedApiKey(stored)).toBe(true);
    expect(hashApiKey(stored)).toBe(
      "af0baec6de29129ca6b961623c6b22f0d89e7d71e2aa3f1c094e2568d221fd0b",
    );
    expect(displayPrefix(stored)).toBe("ac_012345678");
  });

  it("hashes the whole key with SHA-256, and the hash never holds the secret", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()));
    expect(hashApiKey(key)).not.toContain(key.slice(3));
  });

  it("shows 12 characters: enough to tell keys apart, not enough to use one", () => {
    const key = generateApiKey();
    expect(displayPrefix(key)).toBe(key.slice(0, 12));
    expect(displayPrefix(key).length).toBeLessThan(key.length / 2);
  });

  it("tells a key from a session token and from another brand's key", () => {
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.eyJzdWIi.c2ln")).toBe(false);
    expect(looksLikeApiKey("sk_live_deadbeef")).toBe(false);
    const other = createApiKeyCodec({ prefix: "zz_" });
    expect(isWellFormedApiKey(other.generateApiKey())).toBe(false);
    expect(other.isWellFormedApiKey(generateApiKey())).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["the prefix alone", "ac_"],
    ["another brand", `zz_${"a".repeat(32)}`],
    ["uppercase hex", `ac_${"A".repeat(32)}`],
    ["an uppercase prefix", `AC_${"a".repeat(32)}`],
    ["31 characters", `ac_${"a".repeat(31)}`],
    ["33 characters", `ac_${"a".repeat(33)}`],
    ["a letter past f", `ac_${"a".repeat(31)}z`],
    ["a trailing newline", `ac_${"a".repeat(32)}\n`],
    ["a newline in place of the last character", `ac_${"a".repeat(31)}\n`],
    ["a leading space", ` ac_${"a".repeat(32)}`],
    ["a trailing space", `ac_${"a".repeat(32)} `],
    ["text in front", `xac_${"a".repeat(32)}`],
    ["text behind", `ac_${"a".repeat(32)} OR 1=1`],
  ])("refuses %s before any lookup", (_, token) => {
    expect(isWellFormedApiKey(token)).toBe(false);
  });

  it("reads the prefix as a literal, not a pattern", () => {
    // A copy that built `new RegExp(`^${prefix}…`)` accepted the second key below.
    const dotted = createApiKeyCodec({ prefix: "a.b_" });
    expect(dotted.isWellFormedApiKey(dotted.generateApiKey())).toBe(true);
    expect(dotted.isWellFormedApiKey(`aXb_${"a".repeat(32)}`)).toBe(false);
    expect(dotted.looksLikeApiKey(`aXb_${"a".repeat(32)}`)).toBe(false);
  });

  it("refuses an empty prefix, which would make every token look like a key", () => {
    expect(() => createApiKeyCodec({ prefix: "" })).toThrow(TypeError);
  });
});

describe("createApiKeyCodec, base64url", () => {
  const b64 = createApiKeyCodec({ prefix: "ac_", encoding: "base64url" });

  it("mints the prefix and 24 random bytes as 32 base64url characters, never the same twice", () => {
    const keys = Array.from({ length: 500 }, b64.generateApiKey);
    expect(new Set(keys).size).toBe(500);
    for (const key of keys) {
      expect(key).toMatch(/^ac_[A-Za-z0-9_-]{32}$/);
      expect(Buffer.from(key.slice(3), "base64url")).toHaveLength(24);
      expect(b64.isWellFormedApiKey(key)).toBe(true);
    }
  });

  // One key per donor in the shape its own tests use, never a real one, hashed outside this code
  // with `printf %s <key> | shasum -a 256`. Each donor mints 24 bytes of base64url and stores the
  // SHA-256 hex of the whole key; the second has two kinds of key, and the third shows 10
  // characters. A change in any of these orphans that donor's stored keys.
  it.each([
    {
      key: `fk_${"v".repeat(32)}`,
      hash: "734f6607464e9be9914c24beaa41efae5ea0228a353c326ee5f324f4d56a4d22",
      display: "fk_vvvvvvvvv",
    },
    {
      key: "ab_checkonlytoken000000000000000000",
      hash: "218bc67a689c312efdbf7ed473dbcbaea3f6f05733dc9ab7293554f44921795e",
      display: "ab_checkonly",
    },
    {
      key: "abk_checkonlytoken000000000000000000",
      hash: "0b7980e8df22309d020aba0cb8048d3aa231a4dfa376c81f1035651f9cd73227",
      display: "abk_checkonl",
    },
    {
      key: "sg_AbCdEfGhIjKlMnOpQrStUvWxYz-_0123",
      hash: "7b9cd82112b4107ca785b9c019c87dcdc62ff6e0995847d8497f85a5498e5ee4",
      display: "sg_AbCdEfG",
      displayLength: 10,
    },
  ])("keeps the bytes $display… was stored with", ({ key, hash, display, displayLength }) => {
    const codec = createApiKeyCodec({
      prefix: key.slice(0, key.indexOf("_") + 1),
      encoding: "base64url",
      displayLength,
    });
    expect(codec.isWellFormedApiKey(key)).toBe(true);
    expect(codec.looksLikeApiKey(key)).toBe(true);
    expect(codec.hashApiKey(key)).toBe(hash);
    expect(codec.displayPrefix(key)).toBe(display);
  });

  it.each([
    ["base64's +", `ac_${"a".repeat(31)}+`],
    ["base64's /", `ac_${"a".repeat(31)}/`],
    ["base64's padding", `ac_${"a".repeat(31)}=`],
    ["31 characters", `ac_${"a".repeat(31)}`],
    ["33 characters", `ac_${"a".repeat(33)}`],
    ["a trailing newline", `ac_${"a".repeat(32)}\n`],
    ["a session token", "eyJhbGciOiJIUzI1NiJ9.e30.sig"],
  ])("refuses %s before any lookup", (_, token) => {
    expect(b64.isWellFormedApiKey(token)).toBe(false);
  });

  it("does not take a key of the other encoding", () => {
    // Capitals and `_` are base64url only, so the hex codec refuses them; a hex key is also valid
    // base64url, so the reverse is not a test of anything.
    expect(isWellFormedApiKey("ac_AbCdEfGhIjKlMnOpQrStUvWxYz-_0123")).toBe(false);
  });

  it.each([0, 3, 20, 11.5, Number.NaN])("refuses a display length of %s", (displayLength) => {
    // With "ac_" the range is 4 to 19: past the prefix, and at most half the secret.
    expect(() => createApiKeyCodec({ prefix: "ac_", displayLength })).toThrow(/from 4 to 19/);
  });
});
