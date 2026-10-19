/**
 * An API key's bytes: mint, hash, show, recognise. Storage, owners, grants and caps stay with the
 * product. Eight Node backends mint one of two keys with only the prefix changed: the prefix,
 * then 32 characters of secret (16 random bytes in lowercase hex, or 24 in base64url), SHA-256 of
 * the whole key, and 12 characters kept for display (10 in one). A key any of them minted hashes
 * here to the same bytes, so no stored row changes.
 *
 * In `/node` because every one of them hashes synchronously with `node:crypto`, on the auth hot
 * path. Web Crypto's digest is async, and moving to it would change every caller.
 */
import { createHash, randomBytes } from "node:crypto";

/** Characters of secret after the prefix, in both encodings. */
const SECRET_LENGTH = 32;

/** How many random bytes each encoding writes as 32 characters, and the characters it uses. A key
 *  is a random token, so a leak is the only way in: 128 bits in hex, 192 in base64url. 24 bytes is
 *  a whole number of base64 groups, so there is no padding and the last character is as free as
 *  the rest. */
const ENCODINGS = {
  hex: { bytes: 16, alphabet: /^[0-9a-f]+$/ },
  base64url: { bytes: 24, alphabet: /^[A-Za-z0-9_-]+$/ },
} as const;

/** The prefix and the first characters of the secret: enough to tell keys apart in a list, far
 *  too few to use one. Twelve in every donor but one, and stored beside the hash, so a product
 *  keeps the length it started with. */
const DISPLAY_LENGTH = 12;

export interface ApiKeyCodecOptions {
  /** Your brand's literal, such as `"ac_"`. Not a pattern: a `.` in it is a dot. */
  prefix: string;
  /**
   * How the secret is written, which must be how your stored keys were minted. `"hex"`, the
   * default: 16 random bytes as 32 lowercase hex characters. `"base64url"`: 24 random bytes as 32
   * characters of `A-Z`, `a-z`, `0-9`, `-` and `_`.
   */
  encoding?: "hex" | "base64url";
  /** How many characters of the key, prefix included, are kept for display. 12 by default. It is
   *  stored, so keep the length your rows already have. At most the prefix and half the secret. */
  displayLength?: number;
}

/** Plain functions, so you can destructure them and export each under its own name. */
export interface ApiKeyCodec {
  /** A new key. The return value IS the secret: store only its hash and its display prefix. */
  generateApiKey: () => string;
  /** SHA-256 of the whole key, as 64 lowercase hex characters. Look a key up by this. */
  hashApiKey: (key: string) => string;
  /** The first `displayLength` characters (12 by default), safe to store and to show. */
  displayPrefix: (key: string) => string;
  /** Starts with your prefix. Tells a key from a session token, to answer "wrong door". */
  looksLikeApiKey: (token: string) => boolean;
  /** Exactly the shape `generateApiKey` mints. Ask before the lookup, to save a round trip. */
  isWellFormedApiKey: (token: string) => boolean;
}

/**
 * The five functions every backend with API keys writes, bound to its prefix.
 *
 *     export const { generateApiKey, hashApiKey, displayPrefix, looksLikeApiKey, isWellFormedApiKey } =
 *       createApiKeyCodec({ prefix: "ac_" });
 *
 * Keys minted as 24 bytes of base64url take `encoding: "base64url"`.
 *
 * The hash is plain SHA-256 rather than a password hash on purpose: the input is 128 or 192
 * random bits, not something a person chose, so there is no dictionary to slow down, and the
 * lookup stays one indexed read.
 */
export function createApiKeyCodec({
  prefix,
  encoding = "hex",
  displayLength = DISPLAY_LENGTH,
}: ApiKeyCodecOptions): ApiKeyCodec {
  // An empty prefix makes every token "look like" a key, so a session token is sent to the key
  // lookup and refused as a bad key instead of being told it knocked on the wrong door.
  if (!prefix) throw new TypeError('createApiKeyCodec needs a prefix, such as "ac_"');
  const maxDisplayLength = prefix.length + SECRET_LENGTH / 2;
  // The display prefix is stored in the clear. Past half the secret, it starts to give keys away.
  if (
    !Number.isInteger(displayLength) ||
    displayLength <= prefix.length ||
    displayLength > maxDisplayLength
  )
    throw new TypeError(
      `createApiKeyCodec: displayLength must be a whole number from ${prefix.length + 1} to ${maxDisplayLength} for the prefix "${prefix}", not ${displayLength}`,
    );
  const { bytes, alphabet } = ENCODINGS[encoding];
  const keyLength = prefix.length + SECRET_LENGTH;

  return {
    generateApiKey: () => prefix + randomBytes(bytes).toString(encoding),
    hashApiKey: (key) => createHash("sha256").update(key).digest("hex"),
    displayPrefix: (key) => key.slice(0, displayLength),
    looksLikeApiKey: (token) => token.startsWith(prefix),
    // The literal prefix, never a pattern built from it. Three copies wrote
    // `new RegExp(`^${prefix}[0-9a-f]{32}$`)`, which is right only while the prefix holds no
    // regex character: with `a.b_`, it accepts `aXb_…`.
    isWellFormedApiKey: (token) =>
      token.length === keyLength &&
      token.startsWith(prefix) &&
      alphabet.test(token.slice(prefix.length)),
  };
}
