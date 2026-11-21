import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEncodedToken, normalizeProofAmounts } from "@cashu/cashu-ts";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { loadEcash, rollEcash, setEcashMints, type EcashRelays } from "../worker/ecashStore.js";
import { createEcashWallet, EcashError, type EcashStore } from "./wallet.js";
import { startMockMint, type MockMint } from "./mockMint.js";

/** The worker's store, over relays that hold what they are sent. */
function storeFor(signer: NostrSigner, kv = new InMemoryKeyValueStore()) {
  const events = new Map<string, NostrEvent>();
  const relays = {
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent) {
      if (event.kind === 5) {
        for (const tag of event.tags) if (tag[0] === "e") events.delete(tag[1]!);
      }
      events.set(event.id, event);
      return this.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: true, message: "" } })) as RelayPublishOutcome[];
    }
  } as EcashRelays;
  const deps = { signer, store: kv, relays, newKey: () => "cd".repeat(32) };
  const store: EcashStore = { load: () => loadEcash(deps), setMints: (mints) => setEcashMints(deps, mints), roll: (roll) => rollEcash(deps, roll) };
  return { store, events };
}

describe("the ecash wallet at a mint (docs/ecash.md)", () => {
  let mint: MockMint;
  beforeAll(async () => {
    mint = await startMockMint();
  });
  afterAll(() => mint.close());

  const funded = async (sats: number) => {
    const signer = new NostrSigner(generatePrivateKey());
    const { store, events } = storeFor(signer);
    const wallet = createEcashWallet(store);
    await wallet.open();
    await wallet.addMint(mint.url);
    const funding = await wallet.fund(mint.url, sats);
    expect(await wallet.claim(funding)).toBe(false);
    mint.payFunding(funding.quote);
    expect(await wallet.claim(funding)).toBe(true);
    return { wallet, store, events, signer };
  };

  it("adds sats by Lightning, and a second device sees them", async () => {
    const { wallet, store } = await funded(100);
    expect(wallet.balance()).toBe(100);
    expect(wallet.balances()).toEqual([{ mint: mint.url, sats: 100 }]);
    const other = createEcashWallet(store);
    await other.open();
    expect(other.balance()).toBe(100);
  });

  it("pays an invoice: the sats leave, the change comes back, and the rest is still spendable", async () => {
    const { wallet, store } = await funded(100);
    const invoice = mint.invoice(40);
    const quote = await wallet.quote(invoice);
    expect(quote).toMatchObject({ mint: mint.url, amount: 40, feeReserve: 2 });
    // A quote spends nothing.
    expect(wallet.balance()).toBe(100);
    const paid = await wallet.pay(quote);
    expect(paid).toMatchObject({ paid: 40, fee: 1 });
    expect(paid.preimage).toMatch(/^[0-9a-f]{64}$/u);
    expect(mint.paid).toContain(invoice);
    expect(wallet.balance()).toBe(59);
    // What is left is real: read again from where it is kept, checked with the mint, and spent again.
    const again = createEcashWallet(store);
    await again.open();
    expect(again.balance()).toBe(59);
    await again.pay(await again.quote(mint.invoice(50)));
    expect(again.balance()).toBe(8);
  });

  it("will not pay more than it holds, and spends nothing trying", async () => {
    const { wallet } = await funded(20);
    const quote = await wallet.quote(mint.invoice(20));
    await expect(wallet.pay(quote)).rejects.toMatchObject({ code: "not-enough" });
    expect(wallet.balance()).toBe(20);
    await expect(wallet.quote("not an invoice")).rejects.toMatchObject({ code: "bad-input" });
  });

  it("keeps the sats when the mint refuses to pay", async () => {
    const { wallet, store } = await funded(64);
    mint.nextMelt = "refuse";
    await expect(wallet.pay(await wallet.quote(mint.invoice(30)))).rejects.toBeInstanceOf(EcashError);
    expect(wallet.balance()).toBe(64);
    const again = createEcashWallet(store);
    await again.open();
    expect(again.balance()).toBe(64);
    // And they are still good.
    await again.pay(await again.quote(mint.invoice(30)));
    expect(again.balance()).toBe(33);
  });

  it("when the mint takes the ecash and its answer never comes, counts only what the mint says is unspent", async () => {
    const { wallet, store } = await funded(64);
    mint.nextMelt = "take-then-fail";
    await expect(wallet.pay(await wallet.quote(mint.invoice(30)))).rejects.toBeInstanceOf(EcashError);
    // 30 and the 2 held back for routing went with the request; the change is lost with the answer. The rest is safe.
    expect(wallet.balance()).toBe(32);
    const again = createEcashWallet(store);
    await again.open();
    expect(again.balance()).toBe(32);
    await again.pay(await again.quote(mint.invoice(10)));
    expect(again.balance()).toBe(21);
  });

  it("takes in a token from a mint it trusts, makes it its own, and refuses one from a mint it does not know", async () => {
    const giver = await funded(50);
    const taker = await funded(1);
    const proofs = giver.wallet.state().tokens.flatMap((token) => token.proofs);
    const token = getEncodedToken({ mint: mint.url, proofs: normalizeProofAmounts(proofs), unit: "sat" });
    expect(await taker.wallet.receive(token)).toEqual({ mint: mint.url, sats: 50 });
    expect(taker.wallet.balance()).toBe(51);
    // It was swapped: the giver's copy is spent, and opening the giver's wallet finds that out.
    expect((await giver.wallet.open()).tokens).toEqual([]);
    // The same token again is worth nothing.
    await expect(taker.wallet.receive(token)).rejects.toBeInstanceOf(EcashError);
    expect(taker.wallet.balance()).toBe(51);
    const stranger = getEncodedToken({ mint: "https://unknown-mint.example", proofs: normalizeProofAmounts(proofs), unit: "sat" });
    await expect(taker.wallet.receive(stranger)).rejects.toMatchObject({ code: "no-wallet" });
    await expect(taker.wallet.receive("hello")).rejects.toMatchObject({ code: "bad-input" });
  });

  it("adds only an address that answers as a mint", async () => {
    const signer = new NostrSigner(generatePrivateKey());
    const wallet = createEcashWallet(storeFor(signer).store);
    await wallet.open();
    await expect(wallet.addMint("ftp://x")).rejects.toMatchObject({ code: "bad-input" });
    await expect(wallet.addMint("http://127.0.0.1:9")).rejects.toMatchObject({ code: "mint" });
    expect(wallet.state().mints).toEqual([]);
    await expect(wallet.quote(mint.invoice(5))).rejects.toMatchObject({ code: "no-wallet" });
  });
});
