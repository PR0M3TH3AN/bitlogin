/**
 * A Cashu mint for tests: real blind signatures, held in memory, served over
 * HTTP on this machine. It speaks enough of the protocol for a wallet to add
 * sats, swap, pay and check what is spent (NUT-00 to NUT-08), restore what it
 * signed (NUT-09), and can be made to misbehave. By default it refuses an output
 * it has signed before, as standard mints do; `signsAgain` makes it sign it
 * again, the kind of mint a seed must never be used with (docs/ecash-seed-counter.md).
 * TEST SUPPORT ONLY: nothing that ships imports this.
 */
import { createServer, type Server } from "node:http";
import { createBlindSignature, createNewMintKeys, hashToCurve, pointFromHex } from "@cashu/cashu-ts";

type Point = ReturnType<typeof pointFromHex>;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n = 8): string => hex(crypto.getRandomValues(new Uint8Array(n)));

export interface MockMint {
  url: string;
  /** An invoice for this many sats, which the mint knows how to "pay". */
  invoice(sats: number): string;
  /** Mark a funding quote paid, as if its Lightning invoice had been. */
  payFunding(quote: string): void;
  /** Mark every funding quote paid. */
  payAllFunding(): void;
  /** What happens to the next payment: "pay" it, "refuse" it untouched, or take the ecash and then fail to answer. */
  nextMelt: "pay" | "refuse" | "take-then-fail";
  /** Every invoice the mint paid. */
  paid: string[];
  requests: string[];
  /** How many outputs it has signed, each once. */
  signedCount(): number;
  /** How many requests it has refused whole for an output it had signed before, or one given twice. */
  refusedCount(): number;
  close(): Promise<void>;
}

export interface MockMintOptions {
  /** Sign an output it has signed before, instead of refusing the whole request. Off by default. */
  signsAgain?: boolean;
  /** Not say it supports restore or deterministic secrets (NUT-09, NUT-13), and not restore. */
  noRestore?: boolean;
}

export async function startMockMint(options: MockMintOptions = {}): Promise<MockMint> {
  const keys = createNewMintKeys(12);
  const id = keys.keysetId;
  const pub: Record<string, string> = {};
  for (const [amount, key] of Object.entries(keys.pubKeys)) pub[amount] = hex(key as Uint8Array);
  const priv = (amount: number | string): Uint8Array => {
    const key = (keys.privKeys as Record<string, Uint8Array>)[String(amount)];
    if (!key) throw new Error(`no key for ${amount}`);
    return key;
  };
  const spent = new Set<string>();
  const funding = new Map<string, { amount: number; state: "UNPAID" | "PAID" | "ISSUED"; request: string }>();
  const invoices = new Map<string, number>();
  const melts = new Map<string, { request: string; amount: number; fee_reserve: number; state: "UNPAID" | "PAID" }>();
  /** Every output it has signed, by its blinded message: what restore hands back. */
  const signed = new Map<string, { amount: number; id: string; C_: string }>();
  /**
   * Refused before anything is taken, as standard mints do: an output already signed, or one given twice. A mint
   * that `signsAgain` lets them through.
   */
  let refused = 0;
  const fresh = (outputs: { B_: string }[] | undefined): void => {
    if (options.signsAgain || !outputs) return;
    const seen = new Set<string>();
    for (const output of outputs) {
      if (signed.has(output.B_) || seen.has(output.B_)) {
        refused++;
        throw Object.assign(new Error("Blinded message of output already signed"), { code: 10002 });
      }
      seen.add(output.B_);
    }
  };
  const sign = (outputs: { amount: number | string; B_: string }[], amounts?: number[]) =>
    outputs.map((output, i) => {
      const amount = amounts ? amounts[i]! : Number(output.amount);
      const blind = createBlindSignature(pointFromHex(output.B_), priv(amount), id);
      const signature = { amount, id, C_: (blind.C_ as Point).toHex(true) };
      signed.set(output.B_, signature);
      return signature;
    });
  const Y = (secret: string): Point => hashToCurve(new TextEncoder().encode(secret));
  /** Every input is the mint's own, unspent, and none is given twice. Returns their sum. */
  const take = (inputs: { amount: number | string; secret: string; C: string }[]): number => {
    const seen = new Set<string>();
    let sum = 0;
    for (const input of inputs) {
      const expected = Y(input.secret).multiply(BigInt(`0x${hex(priv(input.amount))}`)).toHex(true);
      if (expected !== input.C) throw new Error("a proof is not this mint's");
      if (spent.has(input.secret) || seen.has(input.secret)) throw new Error("Token already spent.");
      seen.add(input.secret);
      sum += Number(input.amount);
    }
    for (const secret of seen) spent.add(secret);
    return sum;
  };
  const split = (amount: number): number[] => {
    const out: number[] = [];
    for (let bit = 1; amount > 0; bit *= 2, amount = Math.floor(amount / 2)) if (amount % 2) out.push(bit);
    return out;
  };

  const mint: MockMint = {
    url: "",
    nextMelt: "pay",
    paid: [],
    requests: [],
    invoice(sats) {
      const request = `lnbc${sats * 10}n1mock${rand(12).replace(/1/gu, "q")}`;
      invoices.set(request, sats);
      return request;
    },
    payFunding(quote) {
      const q = funding.get(quote);
      if (q && q.state === "UNPAID") q.state = "PAID";
    },
    payAllFunding() {
      for (const q of funding.values()) if (q.state === "UNPAID") q.state = "PAID";
    },
    signedCount: () => signed.size,
    refusedCount: () => refused,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };

  const handle = (method: string, path: string, body: any): unknown => {
    if (method === "GET" && path === "/v1/info") {
      return { name: "mock mint", version: "mock/0", nuts: { 4: { methods: [{ method: "bolt11", unit: "sat" }], disabled: false }, 5: { methods: [{ method: "bolt11", unit: "sat" }], disabled: false }, 7: { supported: true }, 8: { supported: true }, ...(options.noRestore ? {} : { 9: { supported: true }, 13: { supported: true } }) } };
    }
    if (method === "GET" && path === "/v1/keysets") return { keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0 }] };
    if (method === "GET" && (path === "/v1/keys" || path === `/v1/keys/${id}`)) return { keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0, keys: pub }] };
    if (method === "POST" && path === "/v1/mint/quote/bolt11") {
      const quote = rand();
      funding.set(quote, { amount: Number(body.amount), state: "UNPAID", request: `lnbc${Number(body.amount) * 10}n1fund${rand(12).replace(/1/gu, "q")}` });
      return { quote, ...funding.get(quote), unit: "sat", expiry: Math.floor(Date.now() / 1000) + 600 };
    }
    if (method === "GET" && path.startsWith("/v1/mint/quote/bolt11/")) {
      const quote = path.split("/").pop()!;
      const q = funding.get(quote);
      if (!q) throw new Error("no such quote");
      return { quote, ...q, unit: "sat", expiry: Math.floor(Date.now() / 1000) + 600 };
    }
    if (method === "POST" && path === "/v1/mint/bolt11") {
      const q = funding.get(body.quote);
      if (!q || q.state !== "PAID") throw new Error("quote not paid");
      if (body.outputs.reduce((sum: number, o: any) => sum + Number(o.amount), 0) !== q.amount) throw new Error("outputs do not match the quote");
      fresh(body.outputs);
      q.state = "ISSUED";
      return { signatures: sign(body.outputs) };
    }
    if (method === "POST" && path === "/v1/swap") {
      const out = body.outputs.reduce((sum: number, o: any) => sum + Number(o.amount), 0);
      const inSum = body.inputs.reduce((sum: number, i: any) => sum + Number(i.amount), 0);
      if (inSum !== out) throw new Error("inputs do not equal outputs");
      fresh(body.outputs);
      take(body.inputs);
      return { signatures: sign(body.outputs) };
    }
    if (method === "POST" && path === "/v1/melt/quote/bolt11") {
      const amount = invoices.get(body.request);
      if (amount === undefined) throw new Error("unknown invoice");
      const quote = rand();
      melts.set(quote, { request: body.request, amount, fee_reserve: Math.max(2, Math.ceil(amount / 100)), state: "UNPAID" });
      return { quote, ...melts.get(quote), unit: "sat", expiry: Math.floor(Date.now() / 1000) + 600, payment_preimage: null };
    }
    if (method === "GET" && path.startsWith("/v1/melt/quote/bolt11/")) {
      const quote = path.split("/").pop()!;
      const q = melts.get(quote);
      if (!q) throw new Error("no such quote");
      return { quote, ...q, unit: "sat", expiry: Math.floor(Date.now() / 1000) + 600, payment_preimage: q.state === "PAID" ? "00".repeat(32) : null };
    }
    if (method === "POST" && path === "/v1/melt/bolt11") {
      const q = melts.get(body.quote);
      if (!q || q.state !== "UNPAID") throw new Error("quote not payable");
      const how = mint.nextMelt;
      mint.nextMelt = "pay";
      if (how === "refuse") throw new Error("Lightning payment failed.");
      const given = body.inputs.reduce((sum: number, i: any) => sum + Number(i.amount), 0);
      if (given < q.amount + q.fee_reserve) throw new Error("not enough inputs");
      fresh(body.outputs);
      take(body.inputs);
      q.state = "PAID";
      mint.paid.push(q.request);
      if (how === "take-then-fail") throw new Error("gateway timeout");
      // Routing cost one sat. The rest of what was given comes back, on the blank outputs.
      const change = split(given - q.amount - 1).slice(0, (body.outputs ?? []).length);
      return { quote: body.quote, ...q, unit: "sat", expiry: 0, payment_preimage: "00".repeat(32), change: sign((body.outputs ?? []).slice(0, change.length), change) };
    }
    if (method === "POST" && path === "/v1/restore" && !options.noRestore) {
      // NUT-09: what it signed, for the blinded messages it is shown. Nothing it didn't sign; nothing changes.
      const found = (body.outputs as { amount: number; id: string; B_: string }[]).filter((o) => signed.has(o.B_));
      return { outputs: found, signatures: found.map((o) => signed.get(o.B_)!) };
    }
    if (method === "POST" && path === "/v1/checkstate") {
      const bySecretY = new Map([...spent].map((secret) => [Y(secret).toHex(true), true]));
      return { states: body.Ys.map((y: string) => ({ Y: y, state: bySecretY.has(y) ? "SPENT" : "UNSPENT", witness: null })) };
    }
    throw Object.assign(new Error("not found"), { status: 404 });
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
      if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
      const path = new URL(req.url ?? "/", "http://x").pathname;
      mint.requests.push(`${req.method} ${path}`);
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const out = handle(req.method ?? "GET", path, body);
        res.writeHead(200, { "content-type": "application/json", ...cors }).end(JSON.stringify(out));
      } catch (err) {
        res.writeHead((err as { status?: number }).status ?? 400, { "content-type": "application/json", ...cors }).end(JSON.stringify({ detail: (err as Error).message, code: (err as { code?: number }).code ?? 11000 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  mint.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return mint;
}
