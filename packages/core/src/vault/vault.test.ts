/**
 * Connection Vault unit tests (connection-vault.md, finalized constants).
 *
 * The vector block pins the §CV6 derivations byte-for-byte: these values are
 * the compatibility contract. If a refactor changes any of them, existing
 * users' vault records become undecryptable — the fix is to revert the
 * refactor, never to update the vectors.
 */
import { describe, expect, it } from "vitest";
import { bytesToHex, base64urlToBytes } from "../crypto/encoding.js";
import {
  validateCredentialVaultFields,
  validateVaultFields,
  CapsuleValidationError,
} from "../capsules/validation.js";
import {
  connectionDTag,
  connectionIdFromDTag,
  derivePersonalPrk,
  deriveRecordKey,
  deriveVaultPrk,
  deriveVaultPublicKey,
  newConnectionId,
} from "./derivation.js";
import {
  parseNwcUri,
  toNwcUri,
  sameNwcCredential,
  NwcParseError,
} from "./nwc.js";
import {
  buildConnectionRecordEvent,
  decryptConnectionRecordEvent,
  tombstoneRecord,
  ConnectionRecordError,
} from "./record.js";
import { VaultSession } from "./session.js";
import {
  SCHEMA_CONNECTION_V1,
  SCHEMA_CONNECTION_NWC_V1,
  type ConnectionRecord,
} from "./types.js";

const ROOT = new Uint8Array(32).map((_, i) => i + 1); // 0x01..0x20
const SUDO = new Uint8Array(32).map((_, i) => 0xa0 + (i % 16));
const FIXED_ID = "AAECAwQFBgcICQoLDA0ODw"; // base64url(0x00..0x0f)

function record(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    schema: SCHEMA_CONNECTION_V1,
    connection_id: FIXED_ID,
    connection_type: "nwc",
    tier: "connectable",
    state: "active",
    label: "Satisfied spending wallet",
    created_at: 1_785_400_000,
    updated_at: 1_785_400_000,
    credential: {
      schema: SCHEMA_CONNECTION_NWC_V1,
      wallet_pubkey: "ab".repeat(32),
      relays: ["wss://relay.example"],
      secret: "cd".repeat(32),
      lud16: null,
      extra_params: [],
    },
    application_binding: {
      origin: "https://imsatisfied.app",
      app_pubkey: null,
    },
    notes: null,
    ...overrides,
  };
}

describe("§CV6 derivation vectors (compatibility contract — never update, only revert)", () => {
  const prk = deriveVaultPrk(ROOT);

  it("vault PRK", () => {
    expect(bytesToHex(prk)).toBe(
      "51c3b1186d216e29366e28bda2bf254b40a99a1fdb36759363749ba6be15d5de",
    );
  });
  it("vault signing identity", () => {
    expect(deriveVaultPublicKey(prk)).toBe(
      "71084b9ea80ad9c54ccab57f3586e7017c194c2266af188abfb433c6e9498af4",
    );
  });
  it("connectable record key", () => {
    expect(bytesToHex(deriveRecordKey(prk, FIXED_ID))).toBe(
      "a01c357bb49de944dc7529947f3bdf781cc368c1823031544e9a50a2c3009dcf",
    );
  });
  it("personal PRK and record key", () => {
    const personal = derivePersonalPrk(ROOT, SUDO);
    expect(bytesToHex(personal)).toBe(
      "bef59847801ae2017f3b45f415c24ab596784392cac23a227261c61e875cf9a3",
    );
    expect(bytesToHex(deriveRecordKey(personal, FIXED_ID))).toBe(
      "63214e56f371acbedbbc8f1106a3ba2aedc6151e13b3374f6410f71adeebdb6c",
    );
  });
  it("rejects roots of the wrong size", () => {
    expect(() => deriveVaultPrk(new Uint8Array(16))).toThrow();
    expect(() => derivePersonalPrk(ROOT, new Uint8Array(31))).toThrow();
  });
});

describe("§CV7 connection identifiers", () => {
  it("generates 16-byte opaque ids that round-trip through the d tag", () => {
    const id = newConnectionId();
    expect(base64urlToBytes(id).length).toBe(16);
    expect(connectionIdFromDTag(connectionDTag(id))).toBe(id);
  });
  it("refuses malformed ids and foreign d tags", () => {
    expect(() => connectionDTag("too-short")).toThrow();
    expect(connectionIdFromDTag("bitlogin:password:v1")).toBeNull();
    expect(
      connectionIdFromDTag("bitlogin:connection:not!base64url!!"),
    ).toBeNull();
  });
});

describe("§CV5.2 capsule vault fields", () => {
  const root = "A".repeat(43); // 32 bytes of base64url
  it("accepts both-present and both-absent, rejects one-without-the-other", () => {
    expect(() => validateVaultFields({})).not.toThrow();
    expect(() =>
      validateVaultFields({
        connection_vault_root: root,
        vault_sudo_key: root,
      }),
    ).not.toThrow();
    expect(() => validateVaultFields({ connection_vault_root: root })).toThrow(
      CapsuleValidationError,
    );
    expect(() => validateVaultFields({ vault_sudo_key: root })).toThrow(
      CapsuleValidationError,
    );
  });
  it("rejects wrong-size and non-base64url values", () => {
    expect(() =>
      validateVaultFields({
        connection_vault_root: "AAAA",
        vault_sudo_key: root,
      }),
    ).toThrow();
    expect(() =>
      validateVaultFields({
        connection_vault_root: "!!!",
        vault_sudo_key: root,
      }),
    ).toThrow();
  });
  it("allows a credential to carry the session root without the phrase-gated sudo key", () => {
    expect(() =>
      validateCredentialVaultFields({ connection_vault_root: root }),
    ).not.toThrow();
    expect(() =>
      validateCredentialVaultFields({
        connection_vault_root: root,
        vault_sudo_key: root,
      }),
    ).not.toThrow();
    expect(() =>
      validateCredentialVaultFields({ vault_sudo_key: root }),
    ).toThrow(CapsuleValidationError);
  });
});

describe("NWC profile (nwc-connections.md §5-§6)", () => {
  const URI =
    "nostr+walletconnect://" +
    "ab".repeat(32) +
    "?relay=wss%3A%2F%2Frelay.one&relay=wss%3A%2F%2Frelay.two&secret=" +
    "CD".repeat(32) +
    "&lud16=adam%40example.com&budget_renewal=weekly";

  it("parses, keeps every relay in order, lowercases hex, retains unknown params", () => {
    const credential = parseNwcUri(URI);
    expect(credential.wallet_pubkey).toBe("ab".repeat(32));
    expect(credential.relays).toEqual(["wss://relay.one", "wss://relay.two"]);
    expect(credential.secret).toBe("cd".repeat(32));
    expect(credential.lud16).toBe("adam@example.com");
    expect(credential.extra_params).toEqual([["budget_renewal", "weekly"]]);
  });

  it("round-trips losslessly through export and re-parse", () => {
    const credential = parseNwcUri(URI);
    expect(parseNwcUri(toNwcUri(credential))).toEqual(credential);
  });

  it("identity of a connection is wallet + secret, not relays or labels", () => {
    const a = parseNwcUri(URI);
    const b = { ...a, relays: ["wss://relay.other"], lud16: null };
    const c = { ...a, secret: "ef".repeat(32) };
    expect(sameNwcCredential(a, b)).toBe(true);
    expect(sameNwcCredential(a, c)).toBe(false);
  });

  it("refuses missing relay, missing secret, bad pubkey, and non-websocket relays", () => {
    const base = `nostr+walletconnect://${"ab".repeat(32)}`;
    expect(() => parseNwcUri(`${base}?secret=${"cd".repeat(32)}`)).toThrow(
      NwcParseError,
    );
    expect(() => parseNwcUri(`${base}?relay=wss%3A%2F%2Fr.example`)).toThrow(
      NwcParseError,
    );
    expect(() =>
      parseNwcUri(
        `nostr+walletconnect://nothex?relay=wss%3A%2F%2Fr&secret=${"cd".repeat(32)}`,
      ),
    ).toThrow(NwcParseError);
    expect(() =>
      parseNwcUri(
        `${base}?relay=https%3A%2F%2Fr.example&secret=${"cd".repeat(32)}`,
      ),
    ).toThrow(NwcParseError);
    expect(() =>
      parseNwcUri(
        `${base}?relay=ws%3A%2F%2Frelay.example&secret=${"cd".repeat(32)}`,
      ),
    ).toThrow(NwcParseError);
    expect(() =>
      parseNwcUri(
        `${base}?relay=ws%3A%2F%2Flocalhost.attacker.example&secret=${"cd".repeat(32)}`,
      ),
    ).toThrow(NwcParseError);
    expect(() =>
      parseNwcUri(
        `${base}?relay=ws%3A%2F%2F127.0.0.1%3A7777&secret=${"cd".repeat(32)}`,
      ),
    ).not.toThrow();
  });
});

describe("§CV8 record events", () => {
  const prk = deriveVaultPrk(ROOT);

  it("encrypts, signs with the vault identity, and round-trips", async () => {
    const event = await buildConnectionRecordEvent({
      vaultPrk: prk,
      recordPrk: prk,
      record: record(),
      now: 1_785_400_100,
    });
    expect(event.pubkey).toBe(deriveVaultPublicKey(prk));
    expect(event.tags).toEqual([["d", `bitlogin:connection:${FIXED_ID}`]]);
    const decrypted = await decryptConnectionRecordEvent(event, prk);
    expect(decrypted?.tier).toBe("connectable");
    expect(decrypted?.record.label).toBe("Satisfied spending wallet");
  });

  it("a different vault's key cannot read or even attribute the record", async () => {
    const event = await buildConnectionRecordEvent({
      vaultPrk: prk,
      recordPrk: prk,
      record: record(),
      now: 1,
    });
    const otherPrk = deriveVaultPrk(new Uint8Array(32).map((_, i) => 99 + i));
    await expect(decryptConnectionRecordEvent(event, otherPrk)).rejects.toThrow(
      /not signed by this vault's identity/,
    );
  });

  it("personal-tier records are INVISIBLE (null) without the personal prk, readable with it", async () => {
    const personalPrk = derivePersonalPrk(ROOT, SUDO);
    const secretRecord = record({
      tier: "personal",
      connection_type: "password",
    });
    const event = await buildConnectionRecordEvent({
      vaultPrk: prk,
      recordPrk: personalPrk,
      record: secretRecord,
      now: 2,
    });
    expect(await decryptConnectionRecordEvent(event, prk)).toBeNull();
    const opened = await decryptConnectionRecordEvent(event, prk, personalPrk);
    expect(opened?.tier).toBe("personal");
  });

  it("rejects a record whose ciphertext id disagrees with the d tag", async () => {
    const event = await buildConnectionRecordEvent({
      vaultPrk: prk,
      recordPrk: prk,
      record: record(),
      now: 3,
    });
    const foreignId = newConnectionId();
    const forged = { ...event, tags: [["d", connectionDTag(foreignId)]] };
    // Re-signing under the vault key is what a compromised relay cannot do,
    // but the AAD check must still hold even against a hypothetical signer:
    // decryption fails because the AAD binds the ciphertext to its own d tag.
    await expect(
      decryptConnectionRecordEvent(
        { ...forged, id: event.id, sig: event.sig },
        prk,
      ),
    ).rejects.toThrow(); // invalid signature for the altered tags
  });

  it("tombstones wipe the credential to its bare schema (§CV11)", () => {
    const dead = tombstoneRecord(
      record({ notes: "has secrets" }),
      1_785_400_500,
    );
    expect(dead.state).toBe("deleted");
    expect(dead.credential).toEqual({ schema: SCHEMA_CONNECTION_NWC_V1 });
    expect(dead.notes).toBeNull();
    expect(dead.updated_at).toBe(1_785_400_500);
  });

  it("validates record shape strictly", async () => {
    await expect(
      buildConnectionRecordEvent({
        vaultPrk: prk,
        recordPrk: prk,
        record: record({ state: "revoked" as never }),
        now: 4,
      }),
    ).rejects.toThrow(ConnectionRecordError);
  });
});

describe("VaultSession sudo-window policy", () => {
  it("personal-tier work requires an open window, and endSudo closes it", async () => {
    const session = new VaultSession(ROOT.slice());
    await expect(
      session.createConnection({
        connection_type: "password",
        tier: "personal",
        label: "insurance portal",
        credential: {
          schema: "bitlogin.connection.password.v1",
          password: "hunter2",
        },
      }),
    ).rejects.toThrow(/sudo window/);

    session.enableSudo(SUDO.slice());
    const { record: created, event } = await session.createConnection({
      connection_type: "password",
      tier: "personal",
      label: "insurance portal",
      credential: {
        schema: "bitlogin.connection.password.v1",
        password: "hunter2",
      },
    });
    expect(created.tier).toBe("personal");
    expect(await session.decryptEvent(event)).not.toBeNull();

    session.endSudo();
    // Same event, closed window: invisible again.
    expect(await session.decryptEvent(event)).toBeNull();
  });

  it("enableSudo consumes (wipes) the caller's key copy", () => {
    const session = new VaultSession(ROOT.slice());
    const copy = SUDO.slice();
    session.enableSudo(copy);
    expect(copy.every((b) => b === 0)).toBe(true);
  });

  it("updates keep tier and id immutable and stay monotonic within a second", async () => {
    const session = new VaultSession(ROOT.slice());
    const { event } = await session.createConnection({
      connection_type: "nwc",
      tier: "connectable",
      label: "wallet",
      credential: record().credential,
      now: 1_785_400_000,
    });
    const current = await session.decryptEvent(event);
    const updated = await session.updateConnection(
      current!,
      { label: "renamed" },
      1_785_400_000,
    );
    // §CV9: same-second replacement must still advance created_at.
    expect(updated.event.created_at).toBe(event.created_at + 1);
    expect(updated.record.connection_id).toBe(current!.record.connection_id);
  });
});
