/**
 * The one JWT both transports sign: APNs' provider token (ES256, under the .p8 key) and Google's
 * service-account assertion (RS256, under the account's RSA key). Web Crypto and nothing else, so
 * no JWT library comes with the subpath.
 */
import { base64UrlOf, bytesOfBase64 } from "../../crypto.ts";

const ALGORITHMS = {
  ES256: {
    key: { name: "ECDSA", namedCurve: "P-256" },
    sign: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    sign: { name: "RSASSA-PKCS1-v1_5" },
  },
} as const;

export type JwtAlgorithm = keyof typeof ALGORITHMS;

/** Named by what `importKey` returns, as in `seal.ts`: Node's types declare `CryptoKey` as a value. */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export type JwtSigner = (
  header: Record<string, string>,
  claims: Record<string, string | number>,
) => Promise<string>;

const encoder = new TextEncoder();
const segment = (value: object): string => base64UrlOf(encoder.encode(JSON.stringify(value)));

/**
 * A PKCS #8 PEM private key, imported once, on the first signature. A key that does not import
 * rejects every signature with the same error, since retrying cannot fix it.
 */
export function jwtSigner(pem: string, algorithm: JwtAlgorithm): JwtSigner {
  let key: Promise<SigningKey> | undefined;
  return async (header, claims) => {
    key ??= importPkcs8(pem, algorithm);
    const input = `${segment({ alg: algorithm, ...header })}.${segment(claims)}`;
    const signature = await crypto.subtle.sign(
      ALGORITHMS[algorithm].sign,
      await key,
      encoder.encode(input),
    );
    return `${input}.${base64UrlOf(new Uint8Array(signature))}`;
  };
}

async function importPkcs8(pem: string, algorithm: JwtAlgorithm): Promise<SigningKey> {
  // A key pasted into a one-line .env arrives with the two characters `\n` where its line breaks
  // were. They are not whitespace, so left in they would corrupt the base64.
  const body = pem.replace(/\\n/g, "\n").replace(/-----(?:BEGIN|END) PRIVATE KEY-----|\s/g, "");
  return crypto.subtle.importKey("pkcs8", bytesOfBase64(body), ALGORITHMS[algorithm].key, false, [
    "sign",
  ]);
}
