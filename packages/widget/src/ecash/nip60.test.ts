import { describe, expect, it } from "vitest";
import { balances, cleanInvoice, cleanMint, cleanProofs, liveTokens, readToken, readWallet, writeHistory, writeToken, writeWallet } from "./nip60.js";

const proof = (secret: string, amount = 8) => ({ id: "00ad268c4d1f5826", amount, secret, C: `02${"ab".repeat(32)}` });
const ID = (n: number) => String(n).padStart(64, "0");

describe("an ecash wallet's records (NIP-60)", () => {
  it("keeps a mint's address only where it is one", () => {
    expect(cleanMint("https://mint.example.com/")).toBe("https://mint.example.com");
    expect(cleanMint(" https://mint.example.com/Bitcoin/ ")).toBe("https://mint.example.com/Bitcoin");
    expect(cleanMint("http://localhost:3338")).toBe("http://localhost:3338");
    for (const bad of ["http://mint.example.com", "https://user:pw@mint.example.com", "https://mint.example.com/?a=1", "javascript:alert(1)", "mint.example.com", "", 4, `https://${"a".repeat(300)}.example`]) expect(cleanMint(bad), String(bad)).toBe("");
  });

  it("writes and reads the wallet record, and never one without its key", () => {
    const wallet = { privkey: "cd".repeat(32), mints: ["https://a.example", "https://b.example"] };
    expect(writeWallet(wallet)).toBe(JSON.stringify([["privkey", wallet.privkey], ["mint", "https://a.example"], ["mint", "https://b.example"]]));
    expect(readWallet(writeWallet(wallet))).toEqual(wallet);
    expect(readWallet(JSON.stringify([["mint", "https://a.example"]]))).toBeNull();
    expect(readWallet(JSON.stringify([["privkey", wallet.privkey], ["mint", "https://a.example/"], ["mint", "https://a.example"], ["mint", "ftp://x"], ["other", 1]]))).toEqual({ privkey: wallet.privkey, mints: ["https://a.example"] });
    expect(readWallet("not json")).toBeNull();
    expect(readWallet("{}")).toBeNull();
  });

  it("reads a token whole or not at all", () => {
    const text = writeToken({ mint: "https://a.example", proofs: [proof("s1"), proof("s2", 2)], del: [ID(1)] });
    expect(JSON.parse(text)).toEqual({ mint: "https://a.example", unit: "sat", proofs: [proof("s1"), proof("s2", 2)], del: [ID(1)] });
    expect(readToken(text)).toEqual({ mint: "https://a.example", proofs: [proof("s1"), proof("s2", 2)], del: [ID(1)] });
    // Another unit is not this wallet's to count as sats.
    expect(readToken(JSON.stringify({ mint: "https://a.example", unit: "usd", proofs: [proof("s1")] }))).toBeNull();
    expect(readToken(JSON.stringify({ mint: "https://a.example", proofs: [proof("s1"), { ...proof("s2"), amount: -1 }] }))).toBeNull();
    expect(readToken(JSON.stringify({ mint: "https://a.example", proofs: [proof("s1"), proof("s1")] }))).toBeNull();
    expect(readToken(JSON.stringify({ mint: "http://a.example", proofs: [proof("s1")] }))).toBeNull();
    for (const bad of [{ ...proof("x"), amount: 1.5 }, { ...proof("x"), C: "zz" }, { ...proof("x"), id: "nothex" }, { ...proof("x"), secret: "" }]) expect(cleanProofs([bad])).toBeNull();
  });

  it("counts only the records that were not replaced or deleted, and no proof twice", () => {
    const records = [
      { event: ID(1), created_at: 100, mint: "https://a.example", proofs: [proof("old", 64)], del: [] },
      // Replaced the first, on a relay that kept the first anyway.
      { event: ID(2), created_at: 200, mint: "https://a.example", proofs: [proof("kept", 32)], del: [ID(1)] },
      { event: ID(3), created_at: 300, mint: "https://b.example", proofs: [proof("b", 4)], del: [] },
      { event: ID(4), created_at: 150, mint: "https://a.example", proofs: [proof("gone", 16)], del: [] },
      // The same proof written twice, by a client that crashed half way: counted once, in the newer record.
      { event: ID(5), created_at: 400, mint: "https://a.example", proofs: [proof("kept", 32), proof("new", 1)], del: [] }
    ];
    const live = liveTokens(records, new Set([ID(4)]));
    expect(live.map((t) => t.event)).toEqual([ID(5), ID(3)]);
    expect(balances(live)).toEqual({ "https://a.example": 33, "https://b.example": 4 });
  });

  it("writes a line of history, and knows an invoice from anything else", () => {
    expect(JSON.parse(writeHistory({ direction: "out", amount: 21, created: [ID(2)], destroyed: [ID(1)] }))).toEqual([["direction", "out"], ["amount", "21"], ["unit", "sat"], ["e", ID(2), "", "created"], ["e", ID(1), "", "destroyed"]]);
    expect(cleanInvoice(" LIGHTNING:LNBC210N1PJQ ")).toBe("lnbc210n1pjq");
    for (const bad of ["lnurl1dp68", "https://x", "lnbc1 x", "", 5, `lnbc${"a".repeat(3000)}`]) expect(cleanInvoice(bad)).toBe("");
  });
});
