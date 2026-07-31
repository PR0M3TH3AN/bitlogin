import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "../storage/interface.js";
import {
  getRecordHighWaterMark,
  raiseRecordHighWaterMark,
  RecordHighWaterMarkError
} from "./recordHighWaterMark.js";
import { deriveVaultPrk, deriveVaultPublicKey } from "./derivation.js";

class InspectableStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

const vaultPrk = deriveVaultPrk(new Uint8Array(32).fill(7));
const connectionId = "AAECAwQFBgcICQoLDA0ODw";
const mark = { createdAt: 1_800_000_000, eventId: "ab".repeat(32) };

describe("authenticated Connection Vault high-water marks", () => {
  it("hides the vault inventory and authenticates the stored value", async () => {
    const store = new InspectableStore();
    await raiseRecordHighWaterMark(store, vaultPrk, connectionId, mark);

    expect(store.values.size).toBe(1);
    const [[key, value]] = [...store.values.entries()];
    expect(key).not.toContain(connectionId);
    expect(key).not.toContain(deriveVaultPublicKey(vaultPrk));
    expect(value).not.toContain(String(mark.createdAt));
    expect(value).not.toContain(mark.eventId);
    expect(await getRecordHighWaterMark(store, vaultPrk, connectionId)).toEqual(mark);

    const parsed = JSON.parse(value) as { ciphertext: string };
    parsed.ciphertext = `${parsed.ciphertext.slice(0, -1)}${parsed.ciphertext.endsWith("A") ? "B" : "A"}`;
    store.values.set(key, JSON.stringify(parsed));
    await expect(getRecordHighWaterMark(store, vaultPrk, connectionId)).rejects.toThrow(RecordHighWaterMarkError);
  });

  it("migrates a valid plaintext v1 marker and deletes the inventory-revealing key", async () => {
    const store = new InspectableStore();
    const legacyKey = `bitlogin:vault-hwm:${deriveVaultPublicKey(vaultPrk)}:${connectionId}`;
    store.values.set(legacyKey, JSON.stringify(mark));

    expect(await getRecordHighWaterMark(store, vaultPrk, connectionId)).toEqual(mark);
    expect(store.values.has(legacyKey)).toBe(false);
    expect(store.values.size).toBe(1);
  });

  it("uses the NIP-01 lower-id tie break", async () => {
    const store = new InspectableStore();
    const higher = { createdAt: mark.createdAt, eventId: "f0".repeat(32) };
    const lower = { createdAt: mark.createdAt, eventId: "01".repeat(32) };
    await raiseRecordHighWaterMark(store, vaultPrk, connectionId, higher);
    await raiseRecordHighWaterMark(store, vaultPrk, connectionId, lower);
    await raiseRecordHighWaterMark(store, vaultPrk, connectionId, higher);
    expect(await getRecordHighWaterMark(store, vaultPrk, connectionId)).toEqual(lower);
  });
});
