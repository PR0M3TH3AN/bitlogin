import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { HANDOFF_PURPOSE, openHandoff, sealHandoff } from "./handoff.js";

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
});
