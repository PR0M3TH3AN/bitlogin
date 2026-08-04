/** Centralized on-ramp handshake (centralized-onramps.md §CO5) — pure logic.
 *
 * The widget's side of the "Sign in with Google/GitHub/…" rail. A host opts in
 * via element attributes; nothing here activates otherwise. The flow:
 *
 *   1. The option row opens `authUrl(provider, state)` in a popup. The service
 *      runs its OAuth dance there.
 *   2. The popup posts ONE message back to the opener:
 *        { type: "bitlogin:onramp:unlock", state,
 *          unlock:   { loginName, password } }            // returning user
 *      or
 *        { type: "bitlogin:onramp:unlock", state,
 *          register: { registrationToken, suggestedLoginName? } }  // new user
 *   3. Returning users go straight into the ordinary password login. New
 *      users register CLIENT-SIDE (standard §15 flow, optionally wrapping an
 *      imported key, §SF10), then the widget POSTs the credential to the
 *      service for safekeeping: { type: "bitlogin:onramp:store",
 *      registrationToken, loginName, password }.
 *
 * Trust boundaries enforced here: messages are accepted only from the
 * configured service's exact origin with the exact per-attempt state nonce
 * (CSPRNG); the store call goes only to the configured URL. Configuring an
 * on-ramp is the HOST'S declaration of trust in that service -- the widget's
 * job is to make sure nobody else can ride that trust.
 */
import { randomBytes, bytesToHex } from "@bitlogin/core/crypto";

export interface OnrampConfig {
  /** The service's auth/store endpoint, as configured. */
  url: string;
  /** Exact origin messages must come from (derived from url). */
  origin: string;
  /** Human name shown in the custody label ("AcmeSigner manages your sign-in"). */
  name: string;
  /** Provider ids to render as rows, e.g. ["google", "github"]. */
  providers: string[];
}

/** Providers we can label nicely; anything else renders capitalized as-is. */
const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  facebook: "Facebook",
  apple: "Apple",
  microsoft: "Microsoft"
};

export function onrampProviderLabel(provider: string): string {
  return (
    KNOWN_PROVIDER_LABELS[provider.toLowerCase()] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

/**
 * Parses the element attributes; returns undefined when no on-ramp is
 * configured, and undefined WITH a console warning when one is configured
 * wrong -- a broken opt-in must fail visibly to the developer, not silently
 * ship a half-working row to users.
 */
export function parseOnrampConfig(attrs: {
  url: string | null;
  name: string | null;
  providers: string | null;
}): OnrampConfig | undefined {
  if (!attrs.url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(attrs.url);
  } catch {
    console.warn("BitLogin: onramp-url is not a valid URL; ignoring the on-ramp configuration.");
    return undefined;
  }
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    console.warn("BitLogin: onramp-url must be https (or loopback for development); ignoring the on-ramp configuration.");
    return undefined;
  }
  const providers = (attrs.providers ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (providers.length === 0) {
    console.warn("BitLogin: onramp-providers is empty; ignoring the on-ramp configuration.");
    return undefined;
  }
  if (!attrs.name?.trim()) {
    console.warn("BitLogin: onramp-name is required (it is the custody label users see); ignoring the on-ramp configuration.");
    return undefined;
  }
  return { url: parsed.toString(), origin: parsed.origin, name: attrs.name.trim(), providers };
}

/** Per-attempt CSPRNG nonce; the popup must echo it exactly. */
export function newOnrampState(): string {
  return bytesToHex(randomBytes(16));
}

export function buildOnrampAuthUrl(config: OnrampConfig, provider: string, state: string, pageOrigin: string): string {
  const url = new URL(config.url);
  url.searchParams.set("provider", provider);
  url.searchParams.set("state", state);
  url.searchParams.set("origin", pageOrigin);
  return url.toString();
}

export type OnrampUnlockResult =
  | { kind: "unlock"; loginName: string; password: string }
  | { kind: "register"; registrationToken: string; suggestedLoginName?: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates a message event against the configured service and the attempt's
 * state nonce. Returns null for anything that doesn't match EXACTLY -- other
 * frames post messages all the time, and none of them get to mint a session.
 */
export function validateOnrampMessage(
  event: { origin: string; data: unknown },
  expected: { origin: string; state: string }
): OnrampUnlockResult | null {
  if (event.origin !== expected.origin) return null;
  const data = event.data as
    | { type?: unknown; state?: unknown; unlock?: unknown; register?: unknown }
    | null
    | undefined;
  if (!data || typeof data !== "object") return null;
  if (data.type !== "bitlogin:onramp:unlock") return null;
  if (data.state !== expected.state) return null;

  const unlock = data.unlock as { loginName?: unknown; password?: unknown } | undefined;
  const register = data.register as
    | { registrationToken?: unknown; suggestedLoginName?: unknown }
    | undefined;
  // Exactly one branch, fully well-formed.
  if (unlock && !register) {
    if (!nonEmptyString(unlock.loginName) || !nonEmptyString(unlock.password)) return null;
    return { kind: "unlock", loginName: unlock.loginName, password: unlock.password };
  }
  if (register && !unlock) {
    if (!nonEmptyString(register.registrationToken)) return null;
    return {
      kind: "register",
      registrationToken: register.registrationToken,
      suggestedLoginName: nonEmptyString(register.suggestedLoginName)
        ? register.suggestedLoginName
        : undefined
    };
  }
  return null;
}

/**
 * Hands a freshly registered credential to the service for safekeeping
 * (Architecture B: the service is the password manager). Only ever called
 * with the host-configured URL. Throws on any non-OK response -- the caller
 * must NOT treat the account as onramp-managed unless the service confirmed
 * it stored the credential.
 */
export async function storeOnrampCredential(
  config: OnrampConfig,
  payload: { registrationToken: string; loginName: string; password: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "bitlogin:onramp:store", ...payload })
  });
  if (!response.ok) {
    throw new Error(
      `${config.name} could not save your sign-in (HTTP ${response.status}). Your account was created -- do not lose the recovery phrase, and try connecting again later.`
    );
  }
}
