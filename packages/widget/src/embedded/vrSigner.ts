/**
 * VR way in the signer frame (embedded/vrWay.ts): the wallet's and the files' asks a world's kit makes where the person
 * chose BitLogin inside VR at the pairing. Answered from BitLogin's own wallet and files code, in this frame, with this
 * site's grant: the kit draws what comes back. Money and files move only after a `confirm` this frame makes and the
 * kit's press answers (`confirmed`), once, after the press guard and within a minute. Amounts are BitLogin's own
 * reading, never the world's words. What it doesn't do is refused in words.
 */
import type { HeadlessSigner } from "../headless.js";
import type { SignerReply } from "./policy.js";
import { createConfirmGate, createVrFetchGuard } from "./vrWay.js";

/** What a VR ask is refused with where it can't be done here: the plain words a world can show. */
export const VR_REFUSED = "Do this on BitLogin's own page.";

type Ask =
  | { t: "walletState"; id: string }
  | { t: "walletReceive"; id: string; sats: number; mint?: string }
  | { t: "walletClaim"; id: string; quote: string }
  | { t: "walletSend"; id: string; invoice: string }
  | { t: "walletToken"; id: string; sats: number }
  | { t: "walletTake"; id: string; token: string }
  | { t: "filesList"; id: string }
  | { t: "fileOpen"; id: string; file: string }
  | { t: "fileSave"; id: string; name: string; type: string; bytes: Uint8Array; private: boolean }
  | { t: "confirmed"; id: string; confirm: string; yes: boolean };
export const VR_ASKS: ReadonlySet<string> = new Set(["walletState", "walletReceive", "walletClaim", "walletSend", "walletToken", "walletTake", "filesList", "fileOpen", "fileSave", "confirmed"]);
export type VrAsk = Ask;
export const isVrAsk = (ask: { t: string }): ask is Ask => VR_ASKS.has(ask.t);

type Confirming = { what: "pay"; id: string; quoted: unknown; sats: number; fee: number } | { what: "take"; id: string; token: string; sats: number; mint: string } | { what: "save"; id: string; name: string; type: string; bytes: Uint8Array; private: boolean };

/** The fetch guard, installed once over this frame's own `fetch`: every https request goes through it, VR way or not. */
const guard = createVrFetchGuard(typeof location === "undefined" ? "" : location.origin);
let installed = false;
export function installVrGuard(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  globalThis.fetch = guard.wrap(globalThis.fetch.bind(globalThis));
}

export function createVrHandler(deps: { signer: () => HeadlessSigner | null; site: () => string; say: (reply: SignerReply) => void }) {
  installVrGuard();
  type Wallet = ReturnType<typeof import("../ecash/wallet.js").createEcashWallet>;
  type Files = ReturnType<typeof import("../drive/files.js").createFiles>;
  let wallet: Wallet | null = null;
  let files: Files | null = null;
  let servers: string[] = [];
  const fundings = new Map<string, Awaited<ReturnType<Wallet["fund"]>>>();
  const gate = createConfirmGate<Confirming>();
  const refuse = (id: string, words = VR_REFUSED) => deps.say({ t: "refused", id, words });
  /** The guard is told the person's own mints and servers, as BitLogin read them, and nothing a world said. */
  const reach = (on: boolean) => guard.set(on ? { vr: true, signedIn: !!deps.signer(), mints: wallet?.state().mints ?? [], servers } : null);

  const openWallet = async (h: HeadlessSigner): Promise<Wallet> => {
    if (wallet) return wallet;
    const { createEcashWallet } = await import("../ecash/wallet.js");
    // The mints come from the wallet's own record, read before any mint is asked.
    reach(false);
    const w = createEcashWallet(h.ecash);
    await w.peek().catch(() => null);
    const state = await h.ecash.load();
    guard.set({ vr: true, signedIn: true, mints: state.mints, servers });
    await w.open({ check: false });
    wallet = w;
    return w;
  };
  const openFiles = async (h: HeadlessSigner): Promise<Files> => {
    if (files) return files;
    const { createFiles } = await import("../drive/files.js");
    servers = await h.drive.servers().then((s) => (Array.isArray(s) ? s : ((s as { mine?: string[] })?.mine ?? []))).catch(() => []);
    reach(true);
    // No storage is paid for from VR: a server that charges asks on BitLogin's page.
    const f = createFiles(h.drive, { confirmPay: async () => false });
    await f.open();
    files = f;
    return f;
  };
  const walletState = (w: Wallet) => {
    const s = w.state();
    return { t: "wallet-state" as const, balance: w.balance(), mints: s.mints.map((mint) => ({ mint, sats: s.tokens.filter((t) => t.mint === mint).reduce((n, t) => n + t.proofs.reduce((m, p) => m + p.amount, 0), 0) })) };
  };

  return {
    /** Forget what this frame held for VR way: the person turned it off, or the grant went. */
    reset() {
      wallet = null;
      files = null;
      fundings.clear();
      reach(false);
    },
    async handle(ask: Ask): Promise<void> {
      const h = deps.signer();
      if (!h) return refuse(ask.id);
      try {
        if (ask.t === "walletState") return deps.say({ ...walletState(await openWallet(h)), id: ask.id } as SignerReply);
        if (ask.t === "walletReceive") {
          const w = await openWallet(h);
          const mint = ask.mint ?? w.state().mints[0];
          if (!mint || !w.state().mints.includes(mint)) return refuse(ask.id, "Add a mint on BitLogin's own page first.");
          const funding = await w.fund(mint, ask.sats);
          fundings.set(funding.quote, funding);
          return deps.say({ t: "invoice", id: ask.id, invoice: funding.invoice, quote: funding.quote, sats: funding.amount } as SignerReply);
        }
        if (ask.t === "walletClaim") {
          const w = await openWallet(h);
          const funding = fundings.get(ask.quote);
          if (!funding) return refuse(ask.id);
          const claimed = await w.claim(funding);
          if (claimed) fundings.delete(ask.quote);
          return deps.say({ ...walletState(w), id: ask.id, claimed } as SignerReply);
        }
        if (ask.t === "walletSend") {
          const w = await openWallet(h);
          const quoted = await w.quote(ask.invoice);
          const c = { what: "pay" as const, id: ask.id, quoted, sats: quoted.amount, fee: quoted.feeReserve };
          return deps.say({ t: "confirm", id: ask.id, confirm: gate.issue(c), what: "pay", sats: quoted.amount, fee: quoted.feeReserve } as SignerReply);
        }
        if (ask.t === "walletToken") return refuse(ask.id);
        if (ask.t === "walletTake") {
          const w = await openWallet(h);
          const { getTokenMetadata } = await import("@cashu/cashu-ts");
          const meta = getTokenMetadata(ask.token) as unknown as { mint: string; amount: number; unit?: string };
          if (!w.state().mints.includes(meta.mint)) return refuse(ask.id, "That token is from a mint you haven't added. Add it on BitLogin's own page first.");
          const c = { what: "take" as const, id: ask.id, token: ask.token, sats: Number(meta.amount), mint: meta.mint };
          return deps.say({ t: "confirm", id: ask.id, confirm: gate.issue(c), what: "take", sats: c.sats, mint: c.mint } as SignerReply);
        }
        if (ask.t === "filesList") {
          const f = await openFiles(h);
          const state = await f.open();
          const list = state.folders.flatMap((folder) => (folder.files ?? []).map((file) => ({ id: file.id, name: file.name, size: file.size, type: file.type, private: !!file.key, folder: folder.name })));
          return deps.say({ t: "files", id: ask.id, files: list } as SignerReply);
        }
        if (ask.t === "fileOpen") {
          const f = await openFiles(h);
          const got = await f.get(ask.file);
          return deps.say({ t: "file", id: ask.id, name: got.name, type: got.type, bytes: got.bytes } as SignerReply);
        }
        if (ask.t === "fileSave") {
          await openFiles(h);
          const c = { what: "save" as const, id: ask.id, name: ask.name, type: ask.type, bytes: ask.bytes, private: ask.private };
          return deps.say({ t: "confirm", id: ask.id, confirm: gate.issue(c), what: "save", name: ask.name, size: ask.bytes.length, private: ask.private } as SignerReply);
        }
        // `confirmed`: the kit's press, for a confirm this frame made.
        const c = gate.answer(ask.confirm, ask.yes);
        if (!c) return refuse(ask.id, "Nothing was done.");
        if (c.what === "pay") {
          const paid = await (await openWallet(h)).pay(c.quoted as never);
          return deps.say({ t: "paid", id: c.id, ...(paid.preimage ? { preimage: paid.preimage } : {}) } as SignerReply);
        }
        if (c.what === "take") {
          const w = await openWallet(h);
          await w.receive(c.token);
          return deps.say({ ...walletState(w), id: c.id } as SignerReply);
        }
        const f = await openFiles(h);
        const folder = await f.worldFolder(deps.site());
        const saved = await f.put(folder.id, { name: c.name, type: c.type, bytes: c.bytes }, { private: c.private });
        return deps.say({ t: "file-saved", id: c.id, name: saved.name, size: saved.size, private: !!saved.key } as SignerReply);
      } catch (err) {
        return refuse(ask.id, String((err as Error)?.message || VR_REFUSED).slice(0, 200));
      }
    }
  };
}
