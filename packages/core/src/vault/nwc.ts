/**
 * NWC connection profile (nwc-connections.md §5-§7).
 *
 * An NWC URI is a bearer credential with active signing authority — parsing
 * happens here, in pure code with no I/O, and the parsed secret must follow
 * the same handling rules as the raw URI: never logged, never in URLs or
 * errors, never at rest outside an encrypted record. Error messages in this
 * file therefore describe SHAPE problems without echoing values.
 */
import { SCHEMA_CONNECTION_NWC_V1, type NwcCredential } from "./types.js";
import { isAllowedRelayUrl } from "../nostr/relayUrl.js";

const HEX64 = /^[0-9a-f]{64}$/u;
const KNOWN_PARAMS = new Set(["relay", "secret", "lud16"]);

export class NwcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NwcParseError";
  }
}

/** Parses a `nostr+walletconnect://` URI into the canonical credential (§6). */
export function parseNwcUri(uri: string): NwcCredential {
  const trimmed = uri.trim();
  if (!/^nostr\+walletconnect:\/\//iu.test(trimmed)) {
    throw new NwcParseError(
      "Not an NWC URI: it must start with nostr+walletconnect://",
    );
  }
  // URL cannot parse the custom scheme portably; swap it for http only to lex.
  let parsed: URL;
  try {
    parsed = new URL(
      trimmed.replace(/^nostr\+walletconnect:\/\//iu, "http://"),
    );
  } catch {
    throw new NwcParseError("The NWC URI is malformed.");
  }
  const walletPubkey = parsed.hostname.toLowerCase();
  if (!HEX64.test(walletPubkey)) {
    throw new NwcParseError(
      "The NWC URI's wallet service pubkey is not 64-char hex.",
    );
  }

  const relays: string[] = [];
  const extraParams: Array<[string, string]> = [];
  let secret: string | null = null;
  let lud16: string | null = null;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (key === "relay") {
      if (!isAllowedRelayUrl(value)) {
        throw new NwcParseError(
          "An NWC relay must use secure WebSockets, except for an explicit loopback development endpoint.",
        );
      }
      relays.push(value);
    } else if (key === "secret") {
      const lowered = value.toLowerCase();
      if (!HEX64.test(lowered)) {
        throw new NwcParseError(
          "The NWC URI's secret is not a 64-char hex client key.",
        );
      }
      secret = lowered;
    } else if (key === "lud16") {
      lud16 = value;
    } else {
      // Unknown parameters are retained verbatim for lossless export (§5).
      extraParams.push([key, value]);
    }
  }
  if (relays.length === 0)
    throw new NwcParseError("The NWC URI names no relay.");
  if (secret === null)
    throw new NwcParseError("The NWC URI carries no secret.");

  return {
    schema: SCHEMA_CONNECTION_NWC_V1,
    wallet_pubkey: walletPubkey,
    relays,
    secret,
    lud16,
    extra_params: extraParams,
  };
}

/** Lossless export back to URI form (§5): known fields plus retained extras. */
export function toNwcUri(credential: NwcCredential): string {
  validateNwcCredential(credential);
  const params = new URLSearchParams();
  for (const relay of credential.relays) params.append("relay", relay);
  params.append("secret", credential.secret);
  if (credential.lud16 !== null) params.append("lud16", credential.lud16);
  for (const [key, value] of credential.extra_params) params.append(key, value);
  return `nostr+walletconnect://${credential.wallet_pubkey}?${params.toString()}`;
}

/** True when two credentials are the SAME connection: same wallet service,
 *  same client secret. Relays/labels/lud16 may drift without making a new
 *  connection — the secret is the identity of the grant. */
export function sameNwcCredential(a: NwcCredential, b: NwcCredential): boolean {
  return a.wallet_pubkey === b.wallet_pubkey && a.secret === b.secret;
}

export function validateNwcCredential(
  credential: unknown,
): asserts credential is NwcCredential {
  const c = credential as Partial<NwcCredential> | null;
  const fail = (message: string) => {
    throw new NwcParseError(message);
  };
  if (!c || typeof c !== "object") fail("NWC credential must be an object.");
  if (c!.schema !== SCHEMA_CONNECTION_NWC_V1)
    fail("NWC credential has the wrong schema.");
  if (typeof c!.wallet_pubkey !== "string" || !HEX64.test(c!.wallet_pubkey)) {
    fail("NWC credential wallet_pubkey must be 64-char lowercase hex.");
  }
  if (
    !Array.isArray(c!.relays) ||
    c!.relays.length === 0 ||
    c!.relays.some((r) => typeof r !== "string")
  ) {
    fail("NWC credential must name at least one relay.");
  }
  if (c!.relays!.some((relay) => !isAllowedRelayUrl(relay))) {
    fail(
      "NWC relays must use secure WebSockets, except for explicit loopback development endpoints.",
    );
  }
  if (typeof c!.secret !== "string" || !HEX64.test(c!.secret)) {
    fail("NWC credential secret must be 64-char lowercase hex.");
  }
  if (c!.lud16 !== null && typeof c!.lud16 !== "string")
    fail("NWC credential lud16 must be a string or null.");
  if (
    !Array.isArray(c!.extra_params) ||
    c!.extra_params.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        typeof p[0] !== "string" ||
        typeof p[1] !== "string",
    )
  ) {
    fail("NWC credential extra_params must be [key, value] string pairs.");
  }
}
