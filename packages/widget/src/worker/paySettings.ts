/**
 * The person's own settings for paying (docs/paying.md): the most a site may
 * ask for at once with no receipt. Kept in this browser first, then on the
 * account's relays as one sealed record, so that it follows them to another
 * device. The newer of the two wins. With no relay answering, the browser's
 * copy stands, and a browser that has neither starts at the default.
 *
 * Runs in the crypto worker, with a full session.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import { countAcknowledgements, verifyNostrEvent, type NostrEvent, type NostrFilter, type RelayPublishOutcome } from "@bitlogin/core/nostr";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { cleanPayLimit, PAY_LIMIT } from "../pay/lightning.js";

export interface PaySettingsRelays {
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  relayUrls: string[];
}

export const PAY_SETTINGS_KIND = 30078;
export const PAY_SETTINGS_D = "bitlogin-pay-settings";

export interface PaySettings {
  /** The most one payment with no receipt may be, in sats. 0: no limit. */
  limitSats: number;
  /** Not on any relay yet: it is sent again the next time it is read. */
  unsaved: boolean;
}

interface Kept {
  limitSats: number;
  at: number;
  saved: boolean;
}

const LOCAL = "bitlogin:pay-settings:v1:";
type Deps = { signer: NostrSigner; store: KeyValueStore; relays: PaySettingsRelays; now?: number };

async function readLocal({ signer, store }: Deps): Promise<Kept | null> {
  const me = signer.getPublicKey();
  try {
    const sealed = await store.get(LOCAL + me);
    const kept = sealed ? (JSON.parse(signer.nip44Decrypt(me, sealed)) as { limitSats?: unknown; at?: unknown; saved?: unknown }) : null;
    return kept && typeof kept.at === "number" ? { limitSats: cleanPayLimit(kept.limitSats), at: kept.at, saved: kept.saved === true } : null;
  } catch {
    return null;
  }
}
const writeLocal = ({ signer, store }: Deps, kept: Kept): Promise<void> => store.set(LOCAL + signer.getPublicKey(), signer.nip44Encrypt(signer.getPublicKey(), JSON.stringify(kept)));

async function send(deps: Deps, kept: Kept): Promise<boolean> {
  const { signer, relays } = deps;
  const me = signer.getPublicKey();
  const record = signer.signEvent({ kind: PAY_SETTINGS_KIND, created_at: Math.floor(kept.at), tags: [["d", PAY_SETTINGS_D]], content: signer.nip44Encrypt(me, JSON.stringify({ v: 1, limitSats: kept.limitSats, at: kept.at })) });
  return countAcknowledgements(await relays.publishAll(record, 5000).catch(() => [])) >= Math.min(2, relays.relayUrls.length);
}

/** Read the settings: the newer of what this browser holds and what relays hold. Never slower than a few seconds. */
export async function loadPaySettings(deps: Deps): Promise<PaySettings> {
  const { signer, relays } = deps;
  const me = signer.getPublicKey();
  let local = await readLocal(deps);
  const found = await relays.queryQuorum({ kinds: [PAY_SETTINGS_KIND], authors: [me], "#d": [PAY_SETTINGS_D], limit: 2 }, 3000).catch(() => null);
  if (found && found.respondedCount > 0) {
    const newest = found.outcomes
      .flatMap((o) => o.events)
      .filter((event) => event.kind === PAY_SETTINGS_KIND && event.pubkey === me && event.tags.some((tag) => tag[0] === "d" && tag[1] === PAY_SETTINGS_D) && verifyNostrEvent(event))
      .sort((a, b) => b.created_at - a.created_at)[0];
    let theirs: Kept | null = null;
    try {
      const body = newest ? (JSON.parse(signer.nip44Decrypt(me, newest.content)) as { limitSats?: unknown; at?: unknown }) : null;
      if (body) theirs = { limitSats: cleanPayLimit(body.limitSats), at: typeof body.at === "number" ? body.at : newest!.created_at, saved: true };
    } catch {
      theirs = null;
    }
    if (theirs && (!local || theirs.at > local.at)) {
      local = theirs;
      await writeLocal(deps, local);
    } else if (local && (!local.saved || !theirs)) {
      // This browser's is the newer, or no relay has one: it is sent again.
      local.saved = await send(deps, local);
      await writeLocal(deps, local);
    }
  }
  return { limitSats: local?.limitSats ?? PAY_LIMIT.default, unsaved: !!local && !local.saved };
}

/** Keep a new limit: in this browser first, then on relays. Anything that is not one of the steps is refused. */
export async function savePaySettings(deps: Deps, input: unknown): Promise<PaySettings> {
  const limitSats = (input as { limitSats?: unknown } | null)?.limitSats;
  if (cleanPayLimit(limitSats) !== limitSats) throw new Error("That is not a limit this wallet keeps.");
  const kept: Kept = { limitSats: limitSats as number, at: deps.now ?? Date.now() / 1000, saved: false };
  await writeLocal(deps, kept);
  kept.saved = await send(deps, kept);
  if (kept.saved) await writeLocal(deps, kept);
  return { limitSats: kept.limitSats, unsaved: !kept.saved };
}
