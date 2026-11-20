import { describe, expect, it } from "vitest";
import { buildRecoveryExport } from "@bitlogin/core/account";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { encodeNpub, encodeNsec, signNostrEvent } from "@bitlogin/core/nostr";
import { buildKeyBackupText } from "./replicaHealth.js";
import { readRestoreFile, RESTORE_FILE_LIMITS } from "./restoreFile.js";

const key = generatePrivateKey();
const pubkey = getPublicKeyHex(key);
const nsec = encodeNsec(key);
const event = signNostrEvent({ kind: 30078, pubkey, created_at: 1_794_000_000, tags: [["d", "x"]], content: "sealed" }, key);
const exported = () => buildRecoveryExport({ recoveryPublicKeyHex: pubkey, vaultRelayUrls: ["wss://relay.example"], recoveryCapsuleEvents: [event], relayListEvents: [], now: 1_794_000_000 });

describe("reading a file that Export identity made", () => {
  it("knows the recovery export, exactly as it was downloaded", () => {
    const read = readRestoreFile(JSON.stringify(exported(), null, 2));
    expect(read.kind).toBe("recovery-export");
    expect(read.kind === "recovery-export" && read.file.recovery_public_key).toBe(pubkey);
    expect(readRestoreFile(`\n  ${JSON.stringify(exported())}\n`).kind).toBe("recovery-export");
  });

  it("knows the key file, exactly as it was downloaded, and takes the key out whole", () => {
    const text = buildKeyBackupText({ npub: encodeNpub(pubkey), nsec, createdAt: new Date(1_794_000_000_000) });
    expect(readRestoreFile(text)).toEqual({ kind: "key", key: nsec });
    // A file that is nothing but the key, and one with Windows line endings.
    expect(readRestoreFile(`${nsec}\n`)).toEqual({ kind: "key", key: nsec });
    expect(readRestoreFile(text.replace(/\n/gu, "\r\n"))).toEqual({ kind: "key", key: nsec });
    // The file tells its reader how to use it.
    expect(text).toContain("Restore from an export file");
  });

  it("refuses a recovery export that was altered, and says why", () => {
    const altered = { ...exported(), recovery_capsule_events: [{ ...event, content: "changed" }] };
    const read = readRestoreFile(JSON.stringify(altered));
    expect(read.kind).toBe("unknown");
    expect(read.kind === "unknown" && read.why).toContain("invalid id or signature");
    expect(readRestoreFile(JSON.stringify({ schema: "something-else" })).kind).toBe("unknown");
    expect(readRestoreFile("{ not json").kind).toBe("unknown");
  });

  it("takes no key from a file that holds none, a cut one, or more than one", () => {
    expect(readRestoreFile("just some notes").kind).toBe("unknown");
    expect(readRestoreFile(`Private key (nsec): ${nsec.slice(0, 40)}`).kind).toBe("unknown");
    // A key with more of the same letters run on after it is not a key.
    expect(readRestoreFile(`${nsec}qqqq`).kind).toBe("unknown");
    const other = encodeNsec(generatePrivateKey());
    const two = readRestoreFile(`${nsec}\n${other}\n`);
    expect(two.kind === "unknown" && two.why).toContain("more than one");
    // The same key written twice is one key.
    expect(readRestoreFile(`${nsec}\n${nsec}\n`)).toEqual({ kind: "key", key: nsec });
    // A public key is not a private one.
    expect(readRestoreFile(encodeNpub(pubkey)).kind).toBe("unknown");
  });

  it("does not read what is not a file of text, or one too large to be an export", () => {
    for (const not of ["", null, undefined, 7, {}]) expect(readRestoreFile(not).kind).toBe("unknown");
    expect(readRestoreFile(`${nsec}\n${" ".repeat(RESTORE_FILE_LIMITS.bytes)}`).kind).toBe("unknown");
  });
});
