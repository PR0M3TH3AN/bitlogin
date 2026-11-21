/**
 * A tip, and the limit on a payment that leaves no receipt (docs/paying.md).
 *
 * A world that asks for a tip names who it is for and how much. It never
 * names an invoice or an address: BitLogin's own page finds the lightning
 * address (the person's own signed profile, or the world's own
 * `/.well-known/nswp.json`), asks that address for an invoice, and pays only
 * an invoice for exactly the amount asked. So a world can't call a payment to
 * itself a tip to somebody else.
 *
 * This runs on BitLogin's sign-in page and panel, which may reach an https
 * address. Nothing here holds a key or a token.
 */

export class TipError extends Error {
  constructor(
    public readonly code: "no-address" | "unreachable" | "refused-amount" | "wrong-invoice",
    message: string
  ) {
    super(message);
    this.name = "TipError";
  }
}

/** The most and the least one tip, or one payment with no receipt, may be asked to be. */
export const TIP_SATS = { min: 1, max: 1_000_000 } as const;
export const cleanSats = (input: unknown): number => (typeof input === "number" && Number.isSafeInteger(input) && input >= TIP_SATS.min && input <= TIP_SATS.max ? input : 0);

/**
 * The most BitLogin pays in one payment that leaves no receipt: a bare
 * invoice a site asked to have paid, or a tip. The person's own to change, on
 * BitLogin's page, in a few steps and not to any number: 0 is "no limit".
 * Kept with the account (worker/paySettings.ts). A purchase has no such
 * limit: it leaves a receipt.
 */
export const PAY_LIMIT = { default: 1000, steps: [1000, 10_000, 100_000, 0] } as const;
/** A limit as it may be kept: one of the steps, or the default. */
export const cleanPayLimit = (input: unknown): number => ((PAY_LIMIT.steps as readonly unknown[]).includes(input) ? (input as number) : PAY_LIMIT.default);
/** Whether a payment of this many sats, with no receipt, is over the limit. */
export const overPayLimit = (sats: number, limit: number): boolean => limit !== 0 && sats > limit;

/**
 * How many sats a Lightning invoice asks for, read from its first part. Null
 * where it names no amount, or one that is not a whole number of sats: such
 * an invoice is never paid for a site.
 */
export function invoiceSats(invoice: unknown): number | null {
  if (typeof invoice !== "string") return null;
  const text = invoice.trim().toLowerCase();
  const cut = text.lastIndexOf("1");
  if (cut < 4) return null;
  const m = /^ln(?:bcrt|tbs|bc|tb)([1-9][0-9]{0,11})([munp]?)$/u.exec(text.slice(0, cut));
  if (!m) return null;
  // In thousandths of a sat, so that nothing is rounded: one bitcoin is 10^11 of them.
  const perUnit: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };
  const msat = m[2] === "p" ? (BigInt(m[1]!) % 10n === 0n ? BigInt(m[1]!) / 10n : -1n) : BigInt(m[1]!) * perUnit[m[2]!]!;
  if (msat <= 0n || msat % 1000n !== 0n) return null;
  const sats = msat / 1000n;
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : null;
}

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;

/**
 * A lightning address (LUD-16): a name at a host, in lower case. Empty for
 * anything else. A host on this machine is one only where `local` says so: a
 * local copy of BitLogin, tried against a local address.
 */
export function cleanLightningAddress(input: unknown, options: { local?: boolean } = {}): string {
  if (typeof input !== "string" || input.length > 200) return "";
  const address = input.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1) return "";
  const name = address.slice(0, at);
  const host = address.slice(at + 1);
  if (!/^[a-z0-9._+-]{1,64}$/u.test(name)) return "";
  if (HOST.test(host)) return address;
  return options.local && LOCAL_HOST.test(host) ? address : "";
}

/** The lightning address a signed profile's words name, where they name one. */
export function lightningAddressOfProfile(content: unknown, options: { local?: boolean } = {}): string {
  try {
    const profile = typeof content === "string" ? (JSON.parse(content) as { lud16?: unknown }) : null;
    return profile && typeof profile === "object" ? cleanLightningAddress(profile.lud16, options) : "";
  } catch {
    return "";
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 8000;

/** Fetch a small JSON document, sending nothing that says who is asking. Null for anything but one. */
async function getJson(fetcher: Fetch, url: string): Promise<Record<string, unknown> | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json" }, signal: stop.signal });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 100_000) return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const webAddress = (input: unknown, local: boolean): URL | null => {
  try {
    const url = new URL(String(input));
    if (typeof input !== "string" || input.length > 2000 || url.username || url.password) return null;
    if (url.protocol === "https:") return url;
    return local && url.protocol === "http:" && LOCAL_HOST.test(url.host) ? url : null;
  } catch {
    return null;
  }
};

/** What a world says of itself, in its own `/.well-known/nswp.json`. */
export interface WorldWord {
  /** The lightning address it takes tips at (`tip`). Empty where it names none. */
  tip: string;
  /** The keys it publishes with (`publishers`). */
  publishers: string[];
}

/**
 * Read a world's own `/.well-known/nswp.json`. The file is fetched from the
 * address the browser says the question came from, so it is that world's
 * word and no other's. Where it can't be read, the world has said nothing.
 */
export async function readWorld(origin: string, options: { fetch?: Fetch; local?: boolean } = {}): Promise<WorldWord> {
  const base = webAddress(origin, options.local === true);
  if (!base || base.origin !== origin) return { tip: "", publishers: [] };
  const found = await getJson(options.fetch ?? ((url, init) => fetch(url, init)), `${base.origin}/.well-known/nswp.json`);
  const named = found?.publishers && typeof found.publishers === "object" && !Array.isArray(found.publishers) ? Object.keys(found.publishers) : [];
  return { tip: cleanLightningAddress(found?.tip, options), publishers: named.filter((key) => /^[0-9a-f]{64}$/u.test(key)).slice(0, 16) };
}

/**
 * Ask a lightning address for an invoice of exactly this many sats (LUD-06,
 * LUD-16). What comes back is checked before it is shown to anyone: it must
 * be an invoice, and for this amount and no other.
 */
export async function invoiceFromAddress(address: string, sats: number, options: { fetch?: Fetch; local?: boolean; /** A note to go with the payment, where the address takes one (LUD-12). */ note?: string } = {}): Promise<{ invoice: string; /** The note that went with it, as it was sent. Empty where the address takes none. */ note: string }> {
  const local = options.local === true;
  const clean = cleanLightningAddress(address, { local });
  const amount = cleanSats(sats);
  if (!clean || !amount) throw new TipError("no-address", "That is not a lightning address and an amount.");
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const [name, host] = [clean.slice(0, clean.lastIndexOf("@")), clean.slice(clean.lastIndexOf("@") + 1)];
  const scheme = local && LOCAL_HOST.test(host) ? "http" : "https";
  const offer = await getJson(fetcher, `${scheme}://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`);
  if (!offer) throw new TipError("unreachable", "That lightning address didn't answer. Nothing was spent.");
  const callback = webAddress(offer.callback, local);
  if (offer.tag !== "payRequest" || !callback) throw new TipError("unreachable", "That lightning address didn't answer as one. Nothing was spent.");
  const msat = amount * 1000;
  const [least, most] = [Number(offer.minSendable), Number(offer.maxSendable)];
  if (!(Number.isFinite(least) && Number.isFinite(most) && least <= msat && msat <= most)) {
    throw new TipError("refused-amount", "That lightning address doesn't take a payment of this size. Nothing was spent.");
  }
  callback.searchParams.set("amount", String(msat));
  // A note goes only where the address says it takes one, and no longer than it takes. Cut short, never refused.
  const room = typeof offer.commentAllowed === "number" && Number.isSafeInteger(offer.commentAllowed) ? Math.min(offer.commentAllowed, 280) : 0;
  const note = room >= 8 ? cleanNote(options.note).slice(0, room) : "";
  if (note) callback.searchParams.set("comment", note);
  const answer = await getJson(fetcher, callback.href);
  const invoice = typeof answer?.pr === "string" ? answer.pr.trim().toLowerCase() : "";
  if (!invoice || invoice.length > 2000 || !/^ln(bc|tb|tbs|bcrt)[0-9a-z]+$/u.test(invoice)) throw new TipError("unreachable", "That lightning address gave no invoice. Nothing was spent.");
  // The one check that matters: an address that answers with a larger invoice is not paid.
  if (invoiceSats(invoice) !== amount) throw new TipError("wrong-invoice", "That lightning address answered with an invoice for a different amount. Nothing was spent.");
  return { invoice, note };
}

/** A note as it may be sent: one line of plain words. */
export function cleanNote(input: unknown): string {
  return typeof input === "string"
    ? Array.from(input.normalize("NFC"))
        .filter((ch) => {
          const c = ch.codePointAt(0)!;
          return c >= 0x20 && c !== 0x7f && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x202a && c <= 0x202e) && !(c >= 0x2066 && c <= 0x2069);
        })
        .join("")
        .trim()
        .slice(0, 280)
    : "";
}

/**
 * The note that tells a person who tipped them, and where (owner, 2026-11-21): privately, with the payment, and to
 * nobody else. `from` is left out where the tipper said to leave their name off, or has none.
 */
export function tipNote(from: string, world: string): string {
  let host = "";
  try {
    host = new URL(world).host;
  } catch {
    host = "";
  }
  const name = cleanNote(from).slice(0, 60);
  return cleanNote(`${name ? `A tip from ${name}` : "A tip"}${host ? `, in ${host}` : ""}`);
}
