/**
 * The wallet's seed and the outputs the worker makes from it (docs/ecash-seed-counter.md, rule 7), against the mock
 * mint. Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Amount, createBlindSignature, createDLEQProof, createNewMintKeys, OutputData, pointFromHex, Wallet } from "@cashu/cashu-ts";
import { generatePrivateKey, hkdfExpand, hkdfExtract, labelSalt } from "@bitlogin/core/crypto";
import { startMockMint, type MockMint } from "../ecash/mockMint.js";
import { ecashSeed, seededBlinded, seededOutputs, seededUnblind, type SeededOutput } from "./ecashSeed.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array(h.match(/../gu)!.map((x) => parseInt(x, 16)));
/** What the page does with what the worker handed it: the library's own output, rebuilt. */
const rebuild = (o: SeededOutput) => new OutputData({ amount: Amount.from(o.amount), id: o.id, B_: o.B_ }, BigInt(`0x${o.blindingFactor}`), bytes(o.secret));

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});

describe("the wallet's seed, made in the worker", () => {
  it("is fixed for an account's key, different for another, and equal to nothing else made from that key", () => {
    const key = generatePrivateKey();
    const seed = ecashSeed(key);
    expect(seed).toHaveLength(64);
    expect(hex(ecashSeed(key))).toBe(hex(seed));
    expect(hex(ecashSeed(generatePrivateKey()))).not.toBe(hex(seed));
    // The same key under any other label gives something else.
    for (const label of ["bitlogin/password-root/v1", "bitlogin/everyday-identity/v1", "bitlogin/ecash-seed/v2"]) {
      expect(hex(hkdfExpand(hkdfExtract(labelSalt(label), key), "nut13", 64))).not.toBe(hex(seed));
    }
    expect(() => ecashSeed(new Uint8Array(31))).toThrow();
  });

  it("makes exactly the library's own seeded outputs, and hands out nothing of the seed", () => {
    const seed = ecashSeed(generatePrivateKey());
    const keysetId = "00ad268c4d1f5826";
    const { outputs, next } = seededOutputs(seed, keysetId, [1, 2, 4], 7);
    expect(outputs.map((o) => o.counter)).toEqual([7, 8, 9]);
    expect(next).toBe(10);
    outputs.forEach((o, i) => expect(o.B_).toBe(OutputData.createSingleDeterministicData(o.amount, seed, 7 + i, keysetId).blindedMessage.B_));
    expect(JSON.stringify(outputs)).not.toContain(hex(seed));
    expect(JSON.stringify(outputs)).not.toContain(hex(seed).slice(0, 32));
    for (const bad of [[0], [], [1.5], Array(101).fill(1)]) expect(() => seededOutputs(seed, keysetId, bad, 1)).toThrow();
    expect(() => seededOutputs(seed, "not a keyset", [1], 1)).toThrow();
    expect(() => seededOutputs(seed, keysetId, [1], 0)).toThrow();
    expect(() => seededOutputs(seed, keysetId, [1], 2 ** 31)).toThrow();
  });

  it("makes the library's own secret and blinding factor, for older and newer keyset ids", () => {
    const seed = ecashSeed(generatePrivateKey());
    for (const keysetId of ["00ad268c4d1f5826", `01${"ab".repeat(32)}`]) {
      const { outputs } = seededOutputs(seed, keysetId, [1, 8], 40);
      outputs.forEach((o, i) => {
        const lib = OutputData.createSingleDeterministicData(o.amount, seed, 40 + i, keysetId);
        expect([o.B_, o.secret, BigInt(`0x${o.blindingFactor}`)]).toEqual([lib.blindedMessage.B_, hex(lib.secret), lib.blindingFactor]);
      });
    }
  });

  it("hands out blinded messages at any counter, and nothing that unblinds them", () => {
    const seed = ecashSeed(generatePrivateKey());
    const keysetId = "00ad268c4d1f5826";
    const blinded = seededBlinded(seed, keysetId, 100, 5);
    expect(blinded.map((b) => b.counter)).toEqual([100, 101, 102, 103, 104]);
    blinded.forEach((b) => expect(b.B_).toBe(OutputData.createSingleDeterministicData(1, seed, b.counter, keysetId).blindedMessage.B_));
    expect(Object.keys(blinded[0]!).sort()).toEqual(["B_", "counter", "id"]);
    for (const [from, count] of [[0, 1], [1, 0], [1, 201], [2 ** 31 - 2, 5]]) expect(() => seededBlinded(seed, keysetId, from, count)).toThrow();
  });

  it("unblinds a mint's signatures into the library's own proofs, in the worker", () => {
    const seed = ecashSeed(generatePrivateKey());
    const keys = createNewMintKeys(4);
    const keysetId = keys.keysetId;
    const pub = Object.fromEntries(Object.entries(keys.pubKeys).map(([a, k]) => [a, hex(k as Uint8Array)]));
    const found = seededBlinded(seed, keysetId, 9, 2).map((b, i) => {
      const amount = [2, 4][i]!;
      const priv = (keys.privKeys as Record<string, Uint8Array>)[String(amount)]!;
      const sig = createBlindSignature(pointFromHex(b.B_), priv, keysetId);
      const dleq = createDLEQProof(pointFromHex(b.B_), priv);
      return { counter: b.counter, amount, C_: sig.C_.toHex(true), dleq: { e: hex(dleq.e), s: hex(dleq.s) } };
    });
    const proofs = seededUnblind(seed, keysetId, { keys: pub, unit: "sat" }, found);
    proofs.forEach((p, i) => {
      const lib = OutputData.createSingleDeterministicData(found[i]!.amount, seed, found[i]!.counter, keysetId).toProof({ id: keysetId, amount: Amount.from(found[i]!.amount), C_: found[i]!.C_ }, { id: keysetId, keys: pub } as never);
      expect([p.secret, p.C, Number(p.amount)]).toEqual([lib.secret, lib.C, found[i]!.amount]);
    });
  });

  it("outputs made by the worker and signed by a mint come back from the seed alone", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    // The page: a wallet with no seed, which uses the outputs the worker made.
    const page = new Wallet(mint.url, { unit: "sat" });
    await page.loadMint();
    const keysetId = page.keysetId;
    const quote = await page.createMintQuoteBolt11(7);
    mint.payAllFunding();
    const { outputs } = seededOutputs(seed, keysetId, [1, 2, 4], 1);
    const proofs = await page.ops.mintBolt11(7, quote).asCustom(outputs.map(rebuild)).run();
    expect(proofs.reduce((n, p) => n + Number(p.amount), 0)).toBe(7);
    // Somewhere else, with the seed and nothing more: the mint hands back the same 7 sats.
    const elsewhere = new Wallet(mint.url, { unit: "sat", bip39seed: seed });
    await elsewhere.loadMint();
    const restored = await elsewhere.batchRestore(300, 100, 0);
    expect(new Set(restored.proofs.map((p) => p.secret))).toEqual(new Set(proofs.map((p) => p.secret)));
  });
});
