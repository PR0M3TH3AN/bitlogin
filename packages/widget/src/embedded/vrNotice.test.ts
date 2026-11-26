/**
 * VR way's notice on the phone: a NIP-17 message from the account to itself, and the wallet history's own mark of a
 * payment made in VR. Each failing before it was built.
 */
import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { verifyNostrEvent } from "@bitlogin/core/nostr";
import { selfNotice, VR_HISTORY_TAG, VR_OFF_LINE, VR_PAYMENTS_HEADING, vrNoticeText } from "./vrNotice.js";
import { readHistory, writeHistory } from "../ecash/nip60.js";

describe("the notice on the phone", () => {
  it("says the amount and the site, in the words given, then the way to turn VR off", () => {
    expect(VR_OFF_LINE).toBe("To turn off BitLogin inside VR: https://bitlogin.network/sites/#vr-off");
    expect(VR_PAYMENTS_HEADING).toBe("Payments made in VR");
    expect(vrNoticeText({ paid: 500 }, "https://grove.bitblocks.network")).toBe(`You paid 500 sats in grove.bitblocks.network. ${VR_OFF_LINE}`);
    expect(vrNoticeText({ token: 21 }, "https://grove.bitblocks.network")).toBe(`You sent 21 sats as a token in grove.bitblocks.network. ${VR_OFF_LINE}`);
    expect(vrNoticeText({ bought: { title: "A hat", sats: 100 } }, "https://grove.bitblocks.network")).toBe(`You bought A hat for 100 sats in grove.bitblocks.network. ${VR_OFF_LINE}`);
  });

  it("is a message from the account to itself, sealed and wrapped, opened only with the account's key", () => {
    const account = new NostrSigner(generatePrivateKey());
    const me = account.getPublicKey();
    const now = 1_800_000_000;
    const wrap = selfNotice(account, "You paid 500 sats in grove.bitblocks.network.", now);
    expect(wrap.kind).toBe(1059);
    expect(verifyNostrEvent(wrap)).toBe(true);
    expect(wrap.pubkey).not.toBe(me);
    expect(wrap.tags).toEqual([["p", me]]);
    expect(wrap.created_at).toBeLessThanOrEqual(now);
    expect(wrap.content).not.toContain("500");
    const seal = JSON.parse(account.nip44Decrypt(wrap.pubkey, wrap.content));
    expect(seal.kind).toBe(13);
    expect(seal.pubkey).toBe(me);
    expect(seal.tags).toEqual([]);
    const rumor = JSON.parse(account.nip44Decrypt(me, seal.content));
    expect(rumor).toMatchObject({ kind: 14, pubkey: me, tags: [["p", me]], content: "You paid 500 sats in grove.bitblocks.network." });
    // Anyone else can't open it.
    const other = new NostrSigner(generatePrivateKey());
    expect(() => other.nip44Decrypt(wrap.pubkey, wrap.content)).toThrow();
  });
});

describe("the wallet's own history of a payment made in VR", () => {
  it("carries the site inside its encrypted content, read back for \"Payments made in VR\", and nothing more", () => {
    const line = writeHistory({ direction: "out", amount: 500, vr: "https://grove.bitblocks.network" });
    expect(JSON.parse(line)).toContainEqual([VR_HISTORY_TAG, "https://grove.bitblocks.network"]);
    expect(readHistory(line)).toEqual({ direction: "out", amount: 500, vr: "https://grove.bitblocks.network" });
    // One made outside VR says nothing of a site; a site that isn't one is left out.
    expect(readHistory(writeHistory({ direction: "out", amount: 5 }))).toEqual({ direction: "out", amount: 5 });
    expect(JSON.parse(writeHistory({ direction: "out", amount: 5, vr: "javascript:x" }))).not.toContainEqual([VR_HISTORY_TAG, "javascript:x"]);
    expect(readHistory("not json")).toBeNull();
  });
});

describe("where the notice and the history's site come from", () => {
  it("is sent after a payment made in VR, by the worker, for the session's own site; a page names no site", async () => {
    const { readFileSync } = await import("node:fs");
    const frame = readFileSync(new URL("./vrSigner.ts", import.meta.url), "utf8");
    const pay = frame.indexOf("const paid = await (await openWallet(h)).pay(c.quoted as never);");
    expect(pay).toBeGreaterThan(-1);
    expect(frame.indexOf("h.vrNotice(paid.paid + paid.fee)", pay)).toBeGreaterThan(pay);
    const worker = readFileSync(new URL("../worker/cryptoWorker.ts", import.meta.url), "utf8");
    // The history line's site is the session's, and only in a VR session, whatever the page passed.
    expect(worker).toContain('if (roll.history) roll.history = { direction: roll.history.direction, amount: roll.history.amount, ...(session.signerOnly && session.vr && session.site && roll.history.direction === "out" ? { vr: session.site } : {}) };');
    const notice = worker.slice(worker.indexOf('case "vrNotice": {'), worker.indexOf('case "vrPayments": {'));
    expect(notice).toContain("if (!session.signerOnly || !session.vr || !session.site) throw new Error(\"refused\");");
    expect(notice).toContain("vrNoticeText({ paid: p.paid as number }, session.site)");
    // The list is read from history, on BitLogin's own page only.
    const list = worker.slice(worker.indexOf('case "vrPayments": {'));
    expect(list).toContain('if (session.signerOnly) throw new Error("This is listed on BitLogin\'s own page.");');
  });
});
