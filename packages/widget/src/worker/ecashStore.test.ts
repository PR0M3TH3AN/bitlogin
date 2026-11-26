import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { keepEcashTrial, loadEcash, peekEcash, rollEcash, setEcashMints, type EcashRelays } from "./ecashStore.js";
import { balances, readToken, TOKEN_KIND, WALLET_KIND, writeWallet } from "../ecash/nip60.js";

const MINT = "https://mint.example";
const proof = (secret: string, amount: number) => ({ id: "00ad268c4d1f5826", amount, secret, C: `02${"ab".repeat(32)}` });

/** Relays that can be switched off: they hold events, honour deletions, and answer or don't. */
function fakeRelays() {
  const events = new Map<string, NostrEvent>();
  const self = {
    up: true,
    events,
    relayUrls: ["wss://a.example", "wss://b.example", "wss://c.example"],
    async queryQuorum(filter: NostrFilter) {
      if (!self.up) return { outcomes: [], respondedCount: 0 };
      const found = [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind) && (filter.authors ?? []).includes(e.pubkey));
      return { outcomes: [{ events: found }], respondedCount: 3 };
    },
    async publishAll(event: NostrEvent): Promise<RelayPublishOutcome[]> {
      if (!self.up) return self.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: false, message: "down" } })) as RelayPublishOutcome[];
      if (event.kind === 5) {
        for (const tag of event.tags) if (tag[0] === "e") events.delete(tag[1]!);
      }
      events.set(event.id, event);
      return self.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: true, message: "" } })) as RelayPublishOutcome[];
    }
  };
  return self as typeof self & EcashRelays;
}

const setup = () => {
  const signer = new NostrSigner(generatePrivateKey());
  return { signer, store: new InMemoryKeyValueStore(), relays: fakeRelays(), newKey: () => "cd".repeat(32) };
};

describe("where an ecash wallet is kept (docs/ecash.md)", () => {
  it("makes a wallet, keeps tokens on relays sealed to the account, and reads them back on another device", async () => {
    const deps = setup();
    expect(await loadEcash(deps)).toEqual({ mints: [], tokens: [], offline: false, unsaved: false });
    expect((await setEcashMints(deps, [`${MINT}/`, MINT, "http://not-tls.example"])).mints).toEqual([MINT]);
    const after = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 64), proof("b", 8)] }], history: { direction: "in", amount: 72 } });
    expect(after.unsaved).toBe(false);
    expect(balances(after.tokens)).toEqual({ [MINT]: 72 });
    // Nothing a relay holds can be read without the key.
    const held = [...deps.relays.events.values()];
    expect(held.map((e) => e.kind).sort()).toEqual([TOKEN_KIND, 7376, WALLET_KIND].sort());
    for (const event of held) expect(event.content).not.toMatch(/mint\.example|"secret"|privkey/u);
    // Another device: the same key, the same relays, and nothing kept locally.
    const elsewhere = await loadEcash({ ...deps, store: new InMemoryKeyValueStore() });
    expect(elsewhere.mints).toEqual([MINT]);
    expect(balances(elsewhere.tokens)).toEqual({ [MINT]: 72 });
    // Someone else's key opens none of it.
    expect(await loadEcash({ ...setup(), relays: deps.relays })).toMatchObject({ mints: [], tokens: [] });
  });

  it("rolls a spent record over: the new one names the old, and the old is deleted", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const first = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 64), proof("b", 8)] }] });
    const old = first.tokens[0]!.event;
    const second = await rollEcash(deps, { destroy: [old], keep: [{ mint: MINT, proofs: [proof("b", 8), proof("change", 2)] }], history: { direction: "out", amount: 62 } });
    expect(balances(second.tokens)).toEqual({ [MINT]: 10 });
    expect(deps.relays.events.has(old)).toBe(false);
    const record = [...deps.relays.events.values()].find((e) => e.kind === TOKEN_KIND)!;
    expect(readToken(deps.signer.nip44Decrypt(deps.signer.getPublicKey(), record.content))!.del).toEqual([old]);
    // A relay that kept the old record anyway can't bring the spent ecash back: the new record says it replaced it.
    deps.relays.events.set(old, { id: old, kind: TOKEN_KIND, pubkey: deps.signer.getPublicKey() } as NostrEvent);
    expect(balances((await loadEcash({ ...deps, store: new InMemoryKeyValueStore() })).tokens)).toEqual({ [MINT]: 10 });
  });

  it("loses nothing when relays are down: the browser's copy is written first, and sent when they are back", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    deps.relays.up = false;
    const offline = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 64)] }] });
    expect(offline.unsaved).toBe(true);
    expect(offline.tokens[0]!.event.startsWith("local:")).toBe(true);
    expect([...deps.relays.events.values()].filter((e) => e.kind === TOKEN_KIND)).toEqual([]);
    // The page is closed and opened again, still with no relay: the wallet opens, from this browser, and says so.
    const still = await loadEcash(deps);
    expect(still).toMatchObject({ mints: [MINT], offline: true, unsaved: true });
    expect(balances(still.tokens)).toEqual({ [MINT]: 64 });
    // What is sealed in the browser can't be read as it lies there.
    const sealed = await deps.store.get(`bitlogin:ecash:v1:${deps.signer.getPublicKey()}`);
    expect(sealed).not.toMatch(/mint\.example|secret/u);
    // Relays are back: opening the wallet sends what they never got.
    deps.relays.up = true;
    const back = await loadEcash(deps);
    expect(back).toMatchObject({ offline: false, unsaved: false });
    expect(balances(back.tokens)).toEqual({ [MINT]: 64 });
    expect([...deps.relays.events.values()].filter((e) => e.kind === TOKEN_KIND).length).toBe(1);
    // And only once: opening it again does not write it twice.
    await loadEcash(deps);
    expect([...deps.relays.events.values()].filter((e) => e.kind === TOKEN_KIND).length).toBe(1);
  });

  it("opens in one sending, however many records wait in this browser and however slowly relays answer (2026-11-24)", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    // Ten changes no relay took: ten records, in this browser only.
    deps.relays.up = false;
    for (let i = 0; i < 10; i++) await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof(`s${i}`, 1)] }] });
    expect((await loadEcash(deps)).tokens.filter((t) => t.event.startsWith("local:"))).toHaveLength(10);
    // Relays that answer questions and take a while over every record sent to them, and say nothing of it.
    deps.relays.up = true;
    const sent: number[] = [];
    const slow = { ...deps.relays, publishAll: async (event: NostrEvent) => (sent.push(event.kind), await new Promise((done) => setTimeout(done, 200)), [] as RelayPublishOutcome[]) };
    const started = Date.now();
    const opened = await loadEcash({ ...deps, relays: slow });
    // One record for the one mint, sent once: not ten, one after another.
    expect(sent).toEqual([TOKEN_KIND]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(opened).toMatchObject({ offline: false, unsaved: true });
    expect(balances(opened.tokens)).toEqual({ [MINT]: 10 });
    // And when a relay does take it, the ten are one record there, and nothing is left only here.
    const after = await loadEcash(deps);
    expect(after.unsaved).toBe(false);
    expect(balances(after.tokens)).toEqual({ [MINT]: 10 });
    expect([...deps.relays.events.values()].filter((e) => e.kind === TOKEN_KIND)).toHaveLength(1);
  });

  it("keeps a saved record that the relays which answered didn't return, until a mint says it is spent (2026-11-24)", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const first = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("held", 21)] }] });
    const saved = first.tokens[0]!.event;
    expect(saved.startsWith("local:")).toBe(false);
    // The relays that answer now don't have that record (the ones that do were slow, or are gone), and didn't delete it.
    const lacking = { ...deps.relays, queryQuorum: async (filter: NostrFilter) => {
      const found = await deps.relays.queryQuorum(filter);
      return { ...found, outcomes: found.outcomes.map((o) => ({ events: o.events.filter((e) => e.id !== saved) })) };
    } };
    const opened = await loadEcash({ ...deps, relays: lacking });
    expect(balances(opened.tokens)).toEqual({ [MINT]: 21 });
    // And it stays in this browser's copy: the next opening with no relay at all still has it.
    deps.relays.up = false;
    expect(balances((await loadEcash(deps)).tokens)).toEqual({ [MINT]: 21 });
  });

  it("still drops a record the relays say was deleted or replaced, though they didn't return it", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const first = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 8)] }] });
    const old = first.tokens[0]!.event;
    // Spent and replaced: the new record names the old one, and the old one is deleted on relays.
    await rollEcash(deps, { destroy: [old], keep: [{ mint: MINT, proofs: [proof("change", 3)] }] });
    expect(deps.relays.events.has(old)).toBe(false);
    const reopened = await loadEcash(deps);
    expect(balances(reopened.tokens)).toEqual({ [MINT]: 3 });
  });

  it("does not delete the old record until what replaces it is on a relay", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const old = (await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 64)] }] })).tokens[0]!.event;
    deps.relays.up = false;
    const spent = await rollEcash(deps, { destroy: [old], keep: [{ mint: MINT, proofs: [proof("change", 4)] }] });
    expect(balances(spent.tokens)).toEqual({ [MINT]: 4 });
    expect(deps.relays.events.has(old)).toBe(true);
    expect(spent.unsaved).toBe(true);
  });

  it("writes many proofs as several small records, each one any NIP-60 wallet can read", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const many = Array.from({ length: 250 }, (_, i) => proof(`s${i}`, 1));
    const after = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: many }] });
    expect(after.tokens.map((t) => t.proofs.length)).toEqual([100, 100, 50]);
    const held = [...deps.relays.events.values()].filter((e) => e.kind === TOKEN_KIND);
    expect(held.length).toBe(3);
    // Each is under the 64 KB an ordinary NIP-44 message may hold.
    for (const event of held) expect(deps.signer.nip44Decrypt(deps.signer.getPublicKey(), event.content).length).toBeLessThan(60_000);
    expect(balances((await loadEcash({ ...deps, store: new InMemoryKeyValueStore() })).tokens)).toEqual({ [MINT]: 250 });
    // Replaced whole: all three go when they are spent, and the first new record names them.
    const next = await rollEcash(deps, { destroy: after.tokens.map((t) => t.event), keep: [{ mint: MINT, proofs: [proof("left", 7)] }] });
    expect(balances(next.tokens)).toEqual({ [MINT]: 7 });
    expect([...deps.relays.events.values()].filter((e) => e.kind === TOKEN_KIND).length).toBe(1);
  });

  it("refuses what is not ecash, and a wallet with no mint", async () => {
    const deps = setup();
    await expect(setEcashMints(deps, [])).rejects.toThrow(/mints/u);
    await expect(rollEcash(deps, { destroy: [], keep: [{ mint: "ftp://x", proofs: [proof("a", 1)] }] })).rejects.toThrow();
    await expect(rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [{ ...proof("a", 1), amount: -5 }] }] })).rejects.toThrow();
  });

  it("says the sats are sealed in this browser before any relay is asked, and sends their history beside them", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const asked: number[] = [];
    const publish = deps.relays.publishAll.bind(deps.relays);
    deps.relays.publishAll = async (event) => (asked.push(event.kind), publish(event));
    let sealedWhenAsked = -1;
    const after = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 64)] }], history: { direction: "in", amount: 64 } }, (sealed) => {
      sealedWhenAsked = asked.length;
      expect(balances(sealed.tokens)).toEqual({ [MINT]: 64 });
      expect(sealed.unsaved).toBe(true);
    });
    expect(sealedWhenAsked).toBe(0);
    expect(after.unsaved).toBe(false);
    expect(asked.sort()).toEqual([TOKEN_KIND, 7376].sort());
  });

  it("takes the line of history back when the record it names wasn't taken", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    const publish = deps.relays.publishAll.bind(deps.relays);
    // The relays take the history and the withdrawal, but not the ecash record.
    deps.relays.publishAll = async (event) =>
      event.kind === TOKEN_KIND ? deps.relays.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: false, message: "no" } })) : publish(event);
    const after = await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("a", 64)] }], history: { direction: "in", amount: 64 } });
    expect(after.unsaved).toBe(true);
    expect([...deps.relays.events.values()].filter((e) => e.kind === 7376)).toEqual([]);
  });
});

describe("a mint's trial, kept with the wallet record (docs/ecash-seed-counter.md, rule 4)", () => {
  const KEYSET = "00ad268c4d1f5826";
  it("is kept here and on relays, read back on another device, and survives a change of mints", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    // Pressed a while after the mint was named: a record of the same second would tie with the one it replaces.
    const kept = await keepEcashTrial({ ...deps, now: Date.now() / 1000 + 5 }, { mint: MINT, keysetId: KEYSET, outcome: "passed" });
    expect(kept.trials).toMatchObject([{ mint: MINT, keysetId: KEYSET, outcome: "passed" }]);
    // Another device, the same key, nothing kept locally.
    const elsewhere = await loadEcash({ ...deps, store: new InMemoryKeyValueStore() });
    expect(elsewhere.trials).toMatchObject([{ mint: MINT, keysetId: KEYSET, outcome: "passed" }]);
    // A newer trial of the same keyset replaces it.
    const again = await keepEcashTrial({ ...deps, now: Date.now() / 1000 + 15 }, { mint: MINT, keysetId: KEYSET, outcome: "failed" });
    expect(again.trials).toHaveLength(1);
    expect(again.trials![0]!.outcome).toBe("failed");
    // Another mint added: the trial stays. The mint removed: its trial goes with it.
    expect((await setEcashMints(deps, [MINT, "https://other.example"])).trials).toHaveLength(1);
    expect((await setEcashMints(deps, ["https://other.example"])).trials).toBeUndefined();
  });

  it("refuses what isn't a trial, or a mint not in the wallet", async () => {
    const deps = setup();
    await setEcashMints(deps, [MINT]);
    await expect(keepEcashTrial(deps, { mint: "https://elsewhere.example", keysetId: KEYSET, outcome: "passed" })).rejects.toThrow();
    await expect(keepEcashTrial(deps, { mint: MINT, keysetId: "x", outcome: "passed" })).rejects.toThrow();
    await expect(keepEcashTrial(deps, { mint: MINT, keysetId: KEYSET, outcome: "maybe" })).rejects.toThrow();
  });
});

describe("a wallet record that replaces another (2026-11-24)", () => {
  const KEYSET = "00ad268c4d1f5826";
  it("is dated after it, even in the same second, so it can't lose to it", async () => {
    const deps = setup();
    const now = Math.floor(Date.now() / 1000);
    await setEcashMints({ ...deps, now }, [MINT]);
    // In the very same second, by the clock: a trial kept.
    await keepEcashTrial({ ...deps, now }, { mint: MINT, keysetId: KEYSET, outcome: "passed" });
    const records = [...deps.relays.events.values()].filter((e) => e.kind === WALLET_KIND).map((e) => e.created_at).sort();
    expect(records).toEqual([now, now + 1]);
    // Another device reads the newer, with the trial in it.
    expect((await loadEcash({ ...deps, store: new InMemoryKeyValueStore() })).trials).toMatchObject([{ outcome: "passed" }]);
  });

  it("read from relays, two of the same second: every device takes the one with the lower id", async () => {
    const deps = setup();
    const me = deps.signer.getPublicKey();
    const at = Math.floor(Date.now() / 1000);
    const make = (mint: string) => deps.signer.signEvent({ kind: WALLET_KIND, created_at: at, tags: [], content: deps.signer.nip44Encrypt(me, writeWallet({ privkey: "cd".repeat(32), mints: [mint] })) });
    const a = make("https://a.example");
    const b = make("https://b.example");
    // The higher id first, as a relay may return it: code with no rule for a tie would take that one.
    for (const e of [a, b].sort((x, y) => y.id.localeCompare(x.id))) deps.relays.events.set(e.id, e);
    const lower = a.id < b.id ? "https://a.example" : "https://b.example";
    for (let i = 0; i < 3; i++) expect((await loadEcash({ ...deps, store: new InMemoryKeyValueStore() })).mints).toEqual([lower]);
  });
});

describe("the wallet record, sent while another tab keeps a claim (fourth review 3)", () => {
  /** Relays that hold the wallet record's publish until let go: the moment another tab writes. */
  const holding = () => {
    const deps = setup();
    let letGo: () => void = () => {};
    const held = new Promise<void>((done) => (letGo = done));
    const publishAll = deps.relays.publishAll.bind(deps.relays);
    let waiting: () => void = () => {};
    const asked = new Promise<void>((done) => (waiting = done));
    deps.relays.publishAll = async (event: NostrEvent) => {
      if (event.kind === WALLET_KIND && hold.on) {
        waiting();
        await held;
      }
      return publishAll(event);
    };
    const hold = { on: false };
    return { deps, hold, asked, letGo };
  };

  it("keeps what another tab sealed while the mints were being sent: setEcashMints", async () => {
    const { deps, hold, asked, letGo } = holding();
    await setEcashMints(deps, [MINT]);
    hold.on = true;
    const changing = setEcashMints(deps, [MINT, "https://other.example"]);
    await asked;
    // Another tab's claim, kept while the record is on its way.
    await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("claimed", 16)] }], history: { direction: "in", amount: 16 } });
    letGo();
    const after = await changing;
    expect(after.mints).toEqual([MINT, "https://other.example"]);
    const local = await peekEcash(deps);
    expect(balances(local.tokens)[MINT]).toBe(16);
  });

  it("keeps what another tab sealed while a trial was being sent: keepEcashTrial", async () => {
    const { deps, hold, asked, letGo } = holding();
    await setEcashMints(deps, [MINT]);
    hold.on = true;
    const keeping = keepEcashTrial(deps, { mint: MINT, keysetId: "00ad268c4d1f5826", outcome: "passed" });
    await asked;
    await rollEcash(deps, { destroy: [], keep: [{ mint: MINT, proofs: [proof("claimed", 16)] }], history: { direction: "in", amount: 16 } });
    letGo();
    await keeping;
    const local = await peekEcash(deps);
    expect(balances(local.tokens)[MINT]).toBe(16);
    expect(local.trials).toMatchObject([{ mint: MINT, keysetId: "00ad268c4d1f5826", outcome: "passed" }]);
  });
});
