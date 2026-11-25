/**
 * The ecash wallet's dealings with a mint (docs/ecash.md): adding sats,
 * taking in a token, and paying a Lightning invoice. This runs on a page of
 * BitLogin's own and nowhere else. It holds tokens in the page's memory for
 * as long as an operation takes; they are kept by the worker
 * (worker/ecashStore.ts), in this browser first and then on relays.
 *
 * The Cashu protocol itself is @cashu/cashu-ts, loaded only when a wallet is
 * opened.
 *
 * Every step that makes new proofs is followed at once by `store.roll`, so
 * nothing new lives only in memory. Where a mint may have taken proofs and
 * the answer never came (a payment that timed out), nothing is thrown away:
 * `reconcile` asks the mint which proofs are spent, the next time the wallet
 * is opened.
 */
import { cleanInvoice, cleanMint, sumProofs, type EcashProof, type EcashToken } from "./nip60.js";
import type { EcashRoll, EcashState } from "../worker/ecashStore.js";
import type { SeededOutput } from "../worker/ecashSeed.js";
import type { LaneState } from "./seedLanes.js";
import type { Lock } from "./seededMint.js";

export interface EcashStore {
  load(): Promise<EcashState>;
  /** The browser's own copy, asking no relay. Optional: where there is none, the wallet opens by `load` alone. */
  peek?(): Promise<EcashState>;
  setMints(mints: string[]): Promise<EcashState>;
  /** `sealed`, where the store can say: called once the new proofs are sealed in this browser, before relays. */
  roll(roll: EcashRoll, sealed?: () => void): Promise<EcashState>;
  /**
   * The seed's half in the worker (docs/ecash-seed-counter.md). Where a store has none of these, nothing is ever
   * added by the seed, and every mint stays relay-kept, as before.
   */
  outputs?(keysetId: string, amounts: number[], from: number): Promise<{ outputs: SeededOutput[]; next: number }>;
  lane?(keysetId: string): Promise<LaneState | null>;
  keepLane?(keysetId: string, state: LaneState): Promise<LaneState | null>;
  keepTrial?(trial: { mint: string; keysetId: string; outcome: "passed" | "failed" }): Promise<EcashState>;
}

/** What a trial of a mint came to, as the screen says it. */
export type MintTrialOutcome = { outcome: "passed" | "failed"; cost: number } | { outcome: "not-tried"; why: string; cost: 0 };

type Cashu = typeof import("@cashu/cashu-ts");
type CashuWallet = InstanceType<Cashu["Wallet"]>;

let cashu: Promise<Cashu> | null = null;
const lib = (): Promise<Cashu> => (cashu ??= import("@cashu/cashu-ts"));

/** A quote to pay an invoice: what it costs at most, before anything is spent. */
export interface PayQuote {
  mint: string;
  invoice: string;
  /** What the invoice asks, in sats. */
  amount: number;
  /** The most the mint may keep for routing, in sats. What it does not use comes back as change. */
  feeReserve: number;
  /** Opaque: handed back to `pay`. */
  quote: unknown;
}

export interface FundQuote {
  mint: string;
  amount: number;
  /** The Lightning invoice to pay, to add `amount` sats. */
  invoice: string;
  quote: string;
  /** When the mint says the invoice runs out, in seconds since 1970, where it says. */
  expiresAt?: number;
}

export class EcashError extends Error {
  constructor(
    readonly code: "no-wallet" | "not-enough" | "mint" | "not-paid" | "bad-input" | "unsaved",
    message: string
  ) {
    super(message);
    this.name = "EcashError";
  }
}

const plain = (proofs: readonly { id: string; amount: { toNumber(): number } | number; secret: string; C: string }[]): EcashProof[] =>
  proofs.map((p) => ({ id: p.id, amount: typeof p.amount === "number" ? p.amount : p.amount.toNumber(), secret: p.secret, C: p.C }));

export function createEcashWallet(store: EcashStore, options: { lock?: Lock } = {}) {
  let state: EcashState = { mints: [], tokens: [], offline: false, unsaved: false };
  const wallets = new Map<string, Promise<CashuWallet>>();
  const at = (mint: string): Promise<CashuWallet> => {
    let wallet = wallets.get(mint);
    if (!wallet) {
      wallet = lib().then(async ({ Wallet }) => {
        const w = new Wallet(mint, { unit: "sat" });
        await w.loadMint();
        return w;
      });
      // A mint that could not be reached is tried again the next time, not remembered as broken.
      wallet.catch(() => wallets.delete(mint));
      wallets.set(mint, wallet);
    }
    return wallet;
  };
  const tokensAt = (mint: string): EcashToken[] => state.tokens.filter((token) => token.mint === mint);
  const proofsAt = (mint: string): EcashProof[] => tokensAt(mint).flatMap((token) => token.proofs);
  const balanceAt = (mint: string): number => sumProofs(proofsAt(mint));
  const mintError = (err: unknown): EcashError => (err instanceof EcashError ? err : new EcashError("mint", `The mint did not do that: ${(err as Error)?.message ?? "no answer"}`));
  const seedParts = () => (store.outputs && store.lane && store.keepLane ? { outputs: store.outputs.bind(store), lane: store.lane.bind(store), keepLane: store.keepLane.bind(store) } : null);
  /** Whether this mint's current keyset has passed the trial (rule 4): only then is anything added there by the seed. */
  const passed = (mint: string, keysetId: string): boolean => (state.trials ?? []).some((t) => t.mint === mint && t.keysetId === keysetId && t.outcome === "passed");
  /**
   * The seeded minter for a mint, or null where the seed isn't used for it: no passed trial for its keyset, no seed
   * in the store, or a browser that can't keep two tabs apart (rule 3a).
   */
  async function seededAt(mint: string, wallet: CashuWallet) {
    const parts = seedParts();
    if (!parts || !passed(mint, wallet.keysetId)) return null;
    const { createSeededMint, browserLock } = await import("./seededMint.js");
    const lock = options.lock ?? browserLock();
    if (!lock) return null;
    return createSeededMint({ wallet, outputs: parts.outputs, load: parts.lane, save: async (id, s) => void (await parts.keepLane(id, s)), lock });
  }

  /**
   * Ask each mint which of the wallet's proofs are spent, and drop those. This is what puts right a payment whose
   * answer never came, a record a relay kept after it was replaced, and ecash spent from another device.
   */
  async function reconcile(): Promise<void> {
    for (const mint of [...new Set(state.tokens.map((token) => token.mint))]) {
      const tokens = tokensAt(mint);
      try {
        const { CheckStateEnum } = await lib();
        const wallet = await at(mint);
        const dirty: EcashToken[] = [];
        const unspent: EcashProof[] = [];
        for (const token of tokens) {
          const states = await wallet.checkProofsStates(token.proofs);
          const left = token.proofs.filter((_, i) => states[i]?.state !== CheckStateEnum.SPENT);
          if (left.length === token.proofs.length) continue;
          dirty.push(token);
          unspent.push(...left);
        }
        if (dirty.length) state = await store.roll({ destroy: dirty.map((token) => token.event), keep: [{ mint, proofs: unspent }] });
      } catch {
        /* a mint that can't be reached now is asked the next time: nothing is dropped on a guess */
      }
    }
  }

  return {
    /**
     * Open the wallet: read it from relays, then (unless `check` is false) put right anything a mint says is spent.
     * The mints can be asked afterwards, with `check()`, so the balance is on screen first.
     */
    async open(o: { check?: boolean } = {}): Promise<EcashState> {
      state = await store.load();
      if (!state.offline && o.check !== false) await reconcile();
      return state;
    },
    /** What the browser holds, shown at once while `open` reads relays. Nothing is spent or written from it. */
    async peek(): Promise<EcashState | null> {
      if (!store.peek) return null;
      state = await store.peek();
      return state;
    },
    /** Ask every mint whether what this wallet holds is still unspent, and put right what isn't. */
    async check(): Promise<EcashState> {
      if (!state.offline) await reconcile();
      return state;
    },
    state: (): EcashState => state,
    balance: (mint?: string): number => (mint ? balanceAt(mint) : sumProofs(state.tokens.flatMap((token) => token.proofs))),
    balances: (): { mint: string; sats: number }[] => [...new Set([...state.mints, ...state.tokens.map((token) => token.mint)])].map((mint) => ({ mint, sats: balanceAt(mint) })),

    /** Add a mint to the wallet, once it has answered as one. Making the wallet, where there is none. */
    async addMint(input: string): Promise<EcashState> {
      const mint = cleanMint(input);
      if (!mint) throw new EcashError("bad-input", "That is not a mint's address. It starts with https://.");
      try {
        await at(mint);
      } catch (err) {
        throw mintError(err);
      }
      state = await store.setMints([...new Set([...state.mints, mint])]);
      return state;
    },
    async removeMint(mint: string): Promise<EcashState> {
      if (balanceAt(mint) > 0) throw new EcashError("bad-input", "That mint still holds sats of yours. Spend them first.");
      const left = state.mints.filter((m) => m !== mint);
      if (left.length === 0) throw new EcashError("bad-input", "A wallet needs one mint.");
      state = await store.setMints(left);
      return state;
    },

    /** An invoice to pay, to add sats at a mint. Nothing is added until it is paid and `claim` is called. */
    async fund(mint: string, sats: number): Promise<FundQuote> {
      if (!state.mints.includes(mint)) throw new EcashError("no-wallet", "That mint is not in this wallet.");
      if (!Number.isSafeInteger(sats) || sats <= 0 || sats > 1_000_000) throw new EcashError("bad-input", "Choose a whole number of sats, up to a million.");
      try {
        const quote = await (await at(mint)).createMintQuoteBolt11(sats);
        const expiresAt = typeof quote.expiry === "number" && quote.expiry > 0 ? quote.expiry : undefined;
        return { mint, amount: sats, invoice: quote.request, quote: quote.quote, ...(expiresAt ? { expiresAt } : {}) };
      } catch (err) {
        throw mintError(err);
      }
    },
    /**
     * Take the sats of a funding invoice, once it is paid. Resolves false while it is not. `added` is called once the
     * mint has issued them and they are sealed in this browser, before relays have them: from then on they are kept.
     */
    async claim(funding: FundQuote, added?: () => void): Promise<boolean> {
      try {
        const { MintQuoteState } = await lib();
        const wallet = await at(funding.mint);
        const checked = await wallet.checkMintQuoteBolt11(funding.quote);
        if (checked.state !== MintQuoteState.PAID) return false;
        // By the seed where this mint has passed the trial (rule 4), so the key alone can bring these sats back;
        // otherwise as before. A mint with every lane in use stays unseeded: nothing was asked of it yet.
        const seeded = await seededAt(funding.mint, wallet);
        let minted: Awaited<ReturnType<CashuWallet["mintProofsBolt11"]>> | null = null;
        if (seeded) {
          try {
            minted = await seeded.add(funding.amount, checked);
          } catch (err) {
            if ((err as { code?: string })?.code !== "no-lane") throw err;
          }
        }
        const proofs = plain(minted ?? (await wallet.mintProofsBolt11(funding.amount, checked)));
        // Sealed in this browser: shown as held from then on, marked as not on a relay yet, until the roll's answer.
        const sealed = () => {
          state = { ...state, tokens: [...state.tokens, { event: "local:sealed", mint: funding.mint, proofs }], unsaved: true };
          added?.();
        };
        state = await store.roll({ destroy: [], keep: [{ mint: funding.mint, proofs }], history: { direction: "in", amount: sumProofs(proofs) } }, sealed);
        return true;
      } catch (err) {
        throw mintError(err);
      }
    },

    /**
     * Whether this wallet can use the seed at all, here: "yes"; "no-seed" where the store has none (nothing is ever
     * added by the seed, and every mint stays relay-kept); "no-locks" where this browser can't keep two tabs apart
     * (rule 3a). Says nothing about any one mint: that is `seededMint`.
     */
    seedHere(): "yes" | "no-seed" | "no-locks" {
      if (!seedParts()) return "no-seed";
      if (options.lock) return "yes";
      const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks;
      return typeof locks?.request === "function" ? "yes" : "no-locks";
    },
    /**
     * Restore from the mints, at the person's press (rule 3): each of the wallet's mints is asked, with outputs made
     * from the seed in every lane, for what it signed and still owes. What it hands back that this wallet doesn't hold
     * is kept with the wallet, and this browser's lane moves forward past what was found in it. Nothing is spent.
     * A mint that can't be reached, or can't restore, is named and left as it is.
     */
    async restore(): Promise<{ found: number; mints: { mint: string; sats: number; trouble?: string }[] }> {
      const parts = seedParts();
      if (!parts) throw new EcashError("no-wallet", "This wallet can't use a seed here.");
      const { restoreFromMint } = await import("./seedRestore.js");
      const mints: { mint: string; sats: number; trouble?: string }[] = [];
      for (const mint of state.mints) {
        try {
          const wallet = await at(mint);
          const restored = await restoreFromMint({ wallet, outputs: parts.outputs });
          const held = new Set(proofsAt(mint).map((p) => p.secret));
          const fresh = plain(restored.proofs).filter((p) => !held.has(p.secret));
          if (fresh.length) state = await store.roll({ destroy: [], keep: [{ mint, proofs: fresh }], history: { direction: "in", amount: sumProofs(fresh) } });
          // This browser's own lane, past what the mint has signed in it: never back, never another lane.
          const mine = await parts.lane(wallet.keysetId);
          const past = mine ? restored.next[mine.lane] : undefined;
          if (mine && past !== undefined && past > mine.next) await parts.keepLane(wallet.keysetId, { lane: mine.lane, next: past });
          mints.push({ mint, sats: sumProofs(fresh) });
        } catch (err) {
          mints.push({ mint, sats: 0, trouble: (err as Error)?.message || "no answer" });
        }
      }
      return { found: mints.reduce((n, m) => n + m.sats, 0), mints };
    },
    /** Whether a mint's current keyset is one the seed is used for (rule 4), as the screen names it. */
    async seededMint(mint: string): Promise<boolean> {
      if (!seedParts()) return false;
      try {
        return passed(mint, (await at(mint)).keysetId);
      } catch {
        return false;
      }
    },
    /**
     * The trial of a mint, at the person's press only (rule 4): one sat of theirs swapped twice into the same output.
     * A mint that refuses the second passes, and the sat stays theirs; one that signs it again fails, and that sat is
     * gone. The outcome is kept with the wallet record, for every device. Never run when the wallet opens.
     */
    async tryMint(mint: string): Promise<MintTrialOutcome> {
      if (!store.outputs || !store.keepTrial) return { outcome: "not-tried", why: "This wallet can't use a seed here.", cost: 0 };
      if (!state.mints.includes(mint)) throw new EcashError("no-wallet", "That mint is not in this wallet.");
      if (balanceAt(mint) < 1) throw new EcashError("not-enough", "The trial needs 1 sat at this mint. Add some first.");
      const { tryMint } = await import("./mintTrial.js");
      let wallet: CashuWallet;
      try {
        wallet = await at(mint);
        // Charging for a swap would make the trial cost more than a sat: not tried, and nothing split for it.
        if (Number(wallet.getFeesForKeyset(1, wallet.keysetId)) > 0) return { outcome: "not-tried", why: "This mint charges for each swap, so it can't be tried for one sat.", cost: 0 };
        // A 1-sat proof to try with: split one off where none is held, and keep the split at once.
        if (!proofsAt(mint).some((p) => p.amount === 1)) {
          const before = tokensAt(mint);
          const split = await wallet.send(1, proofsAt(mint), { includeFees: true });
          state = await store.roll({ destroy: before.map((t) => t.event), keep: [{ mint, proofs: [...plain(split.keep), ...plain(split.send)] }] });
        }
      } catch (err) {
        throw mintError(err);
      }
      const proof = proofsAt(mint).find((p) => p.amount === 1)!;
      const held = tokensAt(mint);
      const rest = proofsAt(mint).filter((p) => p.secret !== proof.secret);
      let result: Awaited<ReturnType<typeof tryMint>>;
      try {
        result = await tryMint({ wallet, outputs: store.outputs.bind(store), proof: proof as never });
      } catch (err) {
        // Where it stopped is unknown from here: the mint is asked what is spent, and nothing is dropped on a guess.
        await reconcile();
        throw mintError(err);
      }
      if (result.outcome === "not-tried") return { outcome: "not-tried", why: result.why, cost: 0 };
      // The sat the trial took: back, as the proof the trial ended with, where it passed; gone where it failed.
      const keep = result.outcome === "passed" ? [...rest, ...plain([result.kept])] : rest;
      state = await store.roll({ destroy: held.map((t) => t.event), keep: [{ mint, proofs: keep }], ...(result.cost ? { history: { direction: "out" as const, amount: result.cost } } : {}) });
      state = await store.keepTrial({ mint, keysetId: result.keysetId, outcome: result.outcome });
      return { outcome: result.outcome, cost: result.cost };
    },

    /** Take in a Cashu token someone gave: it is swapped at its mint for proofs only this wallet knows. */
    async receive(tokenText: string): Promise<{ mint: string; sats: number }> {
      const { getTokenMetadata } = await lib();
      let meta: { mint: string; unit: string };
      try {
        meta = getTokenMetadata(tokenText.trim());
      } catch {
        throw new EcashError("bad-input", "That is not a Cashu token.");
      }
      const mint = cleanMint(meta.mint);
      if (!mint || meta.unit !== "sat") throw new EcashError("bad-input", "That token is not in sats, or names no usable mint.");
      // A token is taken only at a mint the person has chosen to trust: a token from an unknown mint is a promise
      // from a stranger.
      if (!state.mints.includes(mint)) throw new EcashError("no-wallet", `That token is from ${mint}, which is not one of your mints. Add the mint first if you trust it.`);
      try {
        const proofs = plain(await (await at(mint)).receive(tokenText.trim()));
        state = await store.roll({ destroy: [], keep: [{ mint, proofs }], history: { direction: "in", amount: sumProofs(proofs) } });
        return { mint, sats: sumProofs(proofs) };
      } catch (err) {
        throw mintError(err);
      }
    },

    /** What paying an invoice would cost, from the mint that can best afford it. Spends nothing. */
    async quote(invoiceText: string, fromMint?: string): Promise<PayQuote> {
      const invoice = cleanInvoice(invoiceText);
      if (!invoice) throw new EcashError("bad-input", "That is not a Lightning invoice.");
      const mint = fromMint ?? [...state.mints].sort((a, b) => balanceAt(b) - balanceAt(a))[0];
      if (!mint) throw new EcashError("no-wallet", "There is no ecash wallet for this account yet.");
      try {
        const quote = await (await at(mint)).createMeltQuoteBolt11(invoice);
        return { mint, invoice, amount: quote.amount.toNumber(), feeReserve: quote.fee_reserve.toNumber(), quote };
      } catch (err) {
        throw mintError(err);
      }
    },

    /**
     * Pay it. The proofs to spend are chosen (and split at the mint if need be), what was not chosen is kept at
     * once, and then the mint is asked to pay. What the mint did not use for routing comes back as change.
     */
    async pay(quoted: PayQuote): Promise<{ paid: number; fee: number; preimage: string | null }> {
      const { mint } = quoted;
      const need = quoted.amount + quoted.feeReserve;
      if (balanceAt(mint) < need) throw new EcashError("not-enough", `This needs up to ${need} sats, and the wallet holds ${balanceAt(mint)} at that mint.`);
      const before = tokensAt(mint);
      const have = proofsAt(mint);
      const heldBefore = balanceAt(mint);
      let send: EcashProof[];
      try {
        const wallet = await at(mint);
        const split = await wallet.send(need, have, { includeFees: true });
        send = plain(split.send);
        // If the mint split anything, the old proofs are gone and these exist nowhere else yet: keep them now.
        state = await store.roll({ destroy: before.map((token) => token.event), keep: [{ mint, proofs: [...plain(split.keep), ...send] }] });
      } catch (err) {
        if (/insufficient|not enough|balance/iu.test((err as Error)?.message ?? "")) throw new EcashError("not-enough", `The wallet does not hold enough at that mint to cover this and the mint's fees.`);
        throw mintError(err);
      }
      const held = tokensAt(mint);
      const sending = new Set(send.map((proof) => proof.secret));
      const rest = proofsAt(mint).filter((proof) => !sending.has(proof.secret));
      let melted: Awaited<ReturnType<CashuWallet["meltProofsBolt11"]>>;
      try {
        const wallet = await at(mint);
        melted = await wallet.meltProofsBolt11(quoted.quote as Parameters<CashuWallet["meltProofsBolt11"]>[0], send);
      } catch (err) {
        // Paid or not, nobody knows from here. Nothing is dropped: the mint is asked what is spent.
        await reconcile();
        throw mintError(err);
      }
      const { MeltQuoteState } = await lib();
      if (melted.quote.state !== MeltQuoteState.PAID) {
        await reconcile();
        throw new EcashError("not-paid", "The mint has not paid it yet. If it does, the sats are spent; if not, they stay yours. Open the wallet again in a minute to see.");
      }
      const change = plain(melted.change);
      // Everything that left the wallet: the invoice, what routing cost, and any fee the mint takes on its own proofs.
      const spent = heldBefore - sumProofs(rest) - sumProofs(change);
      state = await store.roll({ destroy: held.map((token) => token.event), keep: [{ mint, proofs: [...rest, ...change] }], history: { direction: "out", amount: spent } });
      return { paid: quoted.amount, fee: spent - quoted.amount, preimage: melted.quote.payment_preimage ?? null };
    }
  };
}

export type EcashWalletApi = ReturnType<typeof createEcashWallet>;
