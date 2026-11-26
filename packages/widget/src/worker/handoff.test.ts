import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { HANDOFF_PURPOSE, openAppHandoff, openHandoff, sealHandoff, SIGNER_ONLY_ACTIONS } from "./handoff.js";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("signer hand-off", () => {
  it("carries the everyday key from one worker's throwaway key to the other's, and nothing else", () => {
    const everyday = generatePrivateKey();
    const recipient = generatePrivateKey();
    const sealed = sealHandoff(everyday, getPublicKeyHex(recipient), generatePrivateKey());
    expect(sealed.senderPublicKey).toMatch(/^[0-9a-f]{64}$/);
    // What crosses the pages is ciphertext: the key is not in it in any plain form.
    expect(sealed.payload).not.toContain(hex(everyday));
    expect(JSON.stringify(sealed)).not.toContain(hex(everyday));
    const opened = openHandoff(sealed, recipient);
    expect(hex(opened)).toBe(hex(everyday));
    // The plaintext is the key and a fixed purpose, nothing about an account or a vault.
    const inside = JSON.parse(new NostrSigner(recipient).nip44Decrypt(sealed.senderPublicKey, sealed.payload)) as Record<string, unknown>;
    expect(Object.keys(inside).sort()).toEqual(["key", "purpose", "v"]);
    expect(inside.purpose).toBe(HANDOFF_PURPOSE);
  });

  it("is sealed afresh each time", () => {
    const everyday = generatePrivateKey();
    const recipient = getPublicKeyHex(generatePrivateKey());
    const a = sealHandoff(everyday, recipient, generatePrivateKey());
    const b = sealHandoff(everyday, recipient, generatePrivateKey());
    expect(a.payload).not.toBe(b.payload);
    expect(a.senderPublicKey).not.toBe(b.senderPublicKey);
  });

  it("opens only for the key it was sealed to", () => {
    const sealed = sealHandoff(generatePrivateKey(), getPublicKeyHex(generatePrivateKey()), generatePrivateKey());
    expect(() => openHandoff(sealed, generatePrivateKey())).toThrow(/could not be opened/);
  });

  it("refuses anything that is not exactly a hand-off", () => {
    const recipient = generatePrivateKey();
    const recipientPub = getPublicKeyHex(recipient);
    const sender = new NostrSigner(generatePrivateKey());
    const wrap = (plaintext: string) => ({ senderPublicKey: sender.getPublicKey(), payload: sender.nip44Encrypt(recipientPub, plaintext) });
    const key = hex(generatePrivateKey());
    expect(() => openHandoff(wrap("not json"), recipient)).toThrow(/could not be read/);
    expect(() => openHandoff(wrap(JSON.stringify({ v: 2, purpose: HANDOFF_PURPOSE, key })), recipient)).toThrow(/not a signer hand-off/);
    expect(() => openHandoff(wrap(JSON.stringify({ v: 1, purpose: "something-else", key })), recipient)).toThrow(/not a signer hand-off/);
    expect(() => openHandoff(wrap(JSON.stringify({ v: 1, purpose: HANDOFF_PURPOSE, key: "abc" })), recipient)).toThrow(/not a signer hand-off/);
    expect(() => openHandoff(wrap(JSON.stringify({ v: 1, purpose: HANDOFF_PURPOSE, key: "0".repeat(64) })), recipient)).toThrow(/unusable key/);
    expect(() => openHandoff({ senderPublicKey: "nope", payload: "x" }, recipient)).toThrow(/not a signer hand-off/);
    expect(() => openHandoff(null as never, recipient)).toThrow(/not a signer hand-off/);
  });

  it("will not seal to something that is not a key, or without an identity", () => {
    expect(() => sealHandoff(generatePrivateKey(), "not-a-key", generatePrivateKey())).toThrow(/recipient/);
    expect(() => sealHandoff(new Uint8Array(0), getPublicKeyHex(generatePrivateKey()), generatePrivateKey())).toThrow(/No identity/);
  });
});

describe("a session that arrived by a hand-off", () => {
  it("can sign and say who it is, and is refused everything else", async () => {
    const { SIGNER_ONLY_ACTIONS } = await import("./handoff.js");
    for (const allowed of ["getPublicKey", "signEvent", "getSessionStatus", "logout", "signerKeep", "signerRestore", "signerTouch", "signerForget"]) {
      expect(SIGNER_ONLY_ACTIONS.has(allowed), allowed).toBe(true);
    }
    for (const refused of [
      "exportIdentity", "handoffExport", "nip44Decrypt", "nip04Decrypt", "nip44Encrypt", "changePassword", "buildRecoveryExport",
      "vaultList", "vaultRevealNwc", "vaultSaveNwc", "vaultFindForOrigin", "publishProfileAndRelayLists", "restoreSession", "login", "register"
    ]) {
      expect(SIGNER_ONLY_ACTIONS.has(refused), refused).toBe(false);
    }
  });

  it("is gated before anything else runs, and is never cached", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./cryptoWorker.ts", import.meta.url), "utf8");
    // The gate is the first thing the dispatcher does.
    const handle = source.slice(source.indexOf("async function handle("));
    expect(handle.indexOf("session.signerOnly && !SIGNER_ONLY_ACTIONS.has(action)")).toBeGreaterThan(-1);
    expect(handle.indexOf("session.signerOnly && !SIGNER_ONLY_ACTIONS.has(action)")).toBeLessThan(handle.indexOf("switch (action)"));
    // Accepting a hand-off writes nothing: no session cache, no public record.
    const accept = handle.slice(handle.indexOf('case "handoffAccept"'), handle.indexOf('case "', handle.indexOf('case "handoffAccept"') + 10));
    expect(accept).toContain("session.signerOnly = true");
    expect(accept).not.toMatch(/persistSession|persistPublicSession|saveCachedSession|store\./);
    // A full session is never written as a site's grant: only one that arrived by a hand-off is kept or counted.
    for (const action of ["signerKeep", "signerTouch"]) {
      const body = handle.slice(handle.indexOf(`case "${action}"`), handle.indexOf('case "', handle.indexOf(`case "${action}"`) + 10));
      expect(body, action).toContain("if (!session.signerOnly) throw");
    }
    // And taking a grant up makes a signer-only session, never a full one, and writes nothing to the session cache.
    const restore = handle.slice(handle.indexOf('case "signerRestore"'), handle.indexOf('case "signerTouch"'));
    expect(restore).toContain("session.signerOnly = true");
    expect(restore).not.toMatch(/persistSession|persistPublicSession|saveCachedSession|connectionVaultRoot/u);
    // Ending any session ends being signer-only with it.
    const clear = source.slice(source.indexOf("function clearSession()"), source.indexOf("function clearSession()") + 900);
    expect(clear).toContain("session.signerOnly = false");
  });

  it("carries what an application was approved for inside the seal, read again on both sides", () => {
    const everyday = generatePrivateKey();
    const recipient = generatePrivateKey();
    const app = { site: "https://app.example", permissions: { name: "Example", sign: [7, 1, 1], extra: "ignored" } };
    const sealed = sealHandoff(everyday, getPublicKeyHex(recipient), generatePrivateKey(), app);
    const opened = openAppHandoff(sealed, recipient);
    expect(hex(opened.key)).toBe(hex(everyday));
    // What comes out is what readPermissions made of it, not what a page passed in.
    expect(opened.app).toEqual({ site: "https://app.example", permissions: { name: "Example", sign: [1, 7], appData: [], proofs: [], read: [], peers: [] } });
    // A plain hand-off carries none: the session it makes can sign a note and a reaction and nothing else.
    expect(openAppHandoff(sealHandoff(everyday, getPublicKeyHex(recipient), generatePrivateKey()), recipient).app).toBeNull();
  });

  it("refuses to seal, or to open, a set an application may not be given", () => {
    const everyday = generatePrivateKey();
    const recipient = generatePrivateKey();
    const to = getPublicKeyHex(recipient);
    // A grant that gives a world a terminal on the user's computer, asked for by an address it is not reserved
    // to; BitLogin's own data; a site that is not one.
    for (const app of [
      { site: "https://app.example", permissions: { sign: [1, 27302] } },
      { site: "https://app.example", permissions: { sign: [30078], appData: ["bitlogin:"] } },
      { site: "https://app.example/path", permissions: { sign: [1] } },
      { site: "https://app.example", permissions: {} },
      { site: "https://app.example", permissions: null }
    ]) {
      expect(() => sealHandoff(everyday, to, generatePrivateKey(), app), JSON.stringify(app)).toThrow(/permission set/u);
    }
    // One forged past the sending side is still refused by the receiving one, whole.
    const sender = new NostrSigner(generatePrivateKey());
    const forged = {
      senderPublicKey: sender.getPublicKey(),
      payload: sender.nip44Encrypt(to, JSON.stringify({ v: 1, purpose: HANDOFF_PURPOSE, key: hex(everyday), app: { site: "https://app.example", permissions: { sign: [27302] } } }))
    };
    expect(() => openAppHandoff(forged, recipient)).toThrow(/cannot be read/u);
    expect(() => openHandoff(forged, recipient)).toThrow(/cannot be read/u);
    // The one address those kinds are reserved to may be given them.
    const portal = { site: "https://portal.bitblocks.network", permissions: { sign: [27300, 27302, 27303] } };
    expect(openAppHandoff(sealHandoff(everyday, to, generatePrivateKey(), portal), recipient).app?.permissions.sign).toEqual([27300, 27302, 27303]);
  });

  // The "world" actions (§SW16a to §SW16c) each serve only the site the hand-off was sealed for, and refuse an
  // application. `worldFollow`, and `worldSeal`, `worldUnwrap` and `worldReach`, also need the user to have let that
  // site, by name.
  it("lets a handed-over session ask for nothing beyond signing, the grant, and what an application was approved for", () => {
    expect([...SIGNER_ONLY_ACTIONS].sort()).toEqual(
      ["appDecrypt", "appDecryptEvent", "appEncrypt", "configure", "getPublicKey", "getSessionStatus", "handoffAccept", "handoffBegin", "logout", "pairBegin", "pairCancel", "pairPoll", "roomPass", "signEvent", "signerCheck", "signerForget", "signerHeld", "signerHold", "signerKeep", "signerRestore", "signerTouch", "worldAchieve", "worldFind", "worldFollow", "worldOpen", "worldReach", "worldSave", "worldScore", "worldSeal", "worldUnwrap"]
    );
    // "roomPass" was added with the owner's say (2026-11-19, §SW16): a pass for the one site, built in the worker.
    // "signerCheck" likewise (docs/take-back.md): it asks the user's relays whether the site was taken back.
    // "signerHold" and "signerHeld" likewise (2026-11-21, docs/paying.md): a site's signer keeps, and reads back, the
    // receipts BitLogin's own page handed it for that site's own listings, beside the site's grant.
    // "pairBegin", "pairPoll" and "pairCancel" likewise (2026-11-25, docs/pair-a-headset.md): a headset's signer offers
    // a code and takes up what a phone sealed to it, as it takes up an Allow. Answering one is the phone's own page's,
    // never a signer's: "pairFind", "pairFound", "pairEnd" and "pairAnswer" are not here.
    // Never: exporting the key, raw decrypting, the vault, the account, asking relays anything, or handing the key on again.
    for (const never of ["exportIdentity", "nip44Decrypt", "nip04Decrypt", "nip44Encrypt", "handoffExport", "vaultRevealNwc", "changePassword", "buildRecoveryExport", "loadProfile", "takeBack", "pairFind", "pairFound", "pairEnd", "pairAnswer"]) {
      expect(SIGNER_ONLY_ACTIONS.has(never), never).toBe(false);
    }
  });
});
