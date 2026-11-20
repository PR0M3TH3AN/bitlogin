import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey, getPublicKeyHex, labelSalt } from "@bitlogin/core/crypto";
import { signNostrEvent, verifyNostrEvent, computeEventId, type NostrEvent } from "@bitlogin/core/nostr";
import { buildMessageRelays, cleanMessage, cleanMessageRelay, MESSAGE_LIMITS, openWrap, sealMessage, SEAL_KIND, WRAP_KIND } from "./messages.js";
import { cleanMore } from "./follows.js";
import { prepareForSite, readSignerRequest, readHandoffMessage, HANDOFF_PROTOCOL, SIGNER_PROTOCOL } from "./policy.js";
import { openAppHandoff, sealHandoff } from "../worker/handoff.js";

/** From NSWP's vectors/people.json at 4cde6bf: `sealedForAWorld` and `messages`. The test keys are sha256 of their labels. */
const vectors = JSON.parse(readFileSync(new URL("./messages.vectors.json", import.meta.url), "utf8")) as {
  testKeys: Record<string, { label: string; pubkey: string }>;
  sealedForAWorld: { to: string; text: string; now: number; expect: { message: Record<string, unknown>; seals: NostrEvent[] } };
  messages: { name: string; wrap: unknown; reader: string; expect: unknown }[];
};
const keyOf = (name: string) => new NostrSigner(labelSalt(vectors.testKeys[name]!.label));

/** Wrap a seal for one reader with a key used once: what a world does with what the signer hands back. */
function wrap(seal: NostrEvent, to: string, now = 1_800_000_000): NostrEvent {
  const once = generatePrivateKey();
  const key = new NostrSigner(once.slice());
  return signNostrEvent({ kind: WRAP_KIND, pubkey: getPublicKeyHex(once), created_at: now - 1000, tags: [["p", to]], content: key.nip44Encrypt(to, JSON.stringify(seal)) }, once);
}

describe("private messages from inside a world (NSWP-14)", () => {
  it("holds the keys NSWP's vectors name", () => {
    for (const name of ["key1", "key2", "session"]) expect(keyOf(name).getPublicKey(), name).toBe(vectors.testKeys[name]!.pubkey);
  });

  it("opens and refuses exactly what NSWP's vectors say", () => {
    expect(vectors.messages.length).toBeGreaterThanOrEqual(7);
    for (const c of vectors.messages) expect(openWrap(keyOf(c.reader), c.wrap), c.name).toEqual(c.expect);
  });

  it("writes the message NSWP's vectors have, and seals that same text to its reader and its writer", () => {
    const v = vectors.sealedForAWorld;
    const writer = keyOf("key1");
    const sealed = sealMessage(writer, { to: v.to, text: v.text, nowSeconds: v.now })!;
    expect(sealed.message).toEqual(v.expect.message);
    expect(sealed.seals).toHaveLength(2);
    const [forReader, forWriter] = sealed.seals;
    // The nonces are fresh here, so the ciphertext differs: everything else is the vector's, and what is inside is
    // the same text as the vector's own seals hold.
    for (const [i, seal] of sealed.seals.entries()) {
      expect(verifyNostrEvent(seal)).toBe(true);
      expect({ kind: seal.kind, created_at: seal.created_at, tags: seal.tags, pubkey: seal.pubkey }).toEqual({ kind: SEAL_KIND, created_at: v.now, tags: [], pubkey: v.expect.seals[i]!.pubkey });
    }
    const reader = keyOf("key2");
    expect(reader.nip44Decrypt(writer.getPublicKey(), forReader.content)).toBe(reader.nip44Decrypt(writer.getPublicKey(), v.expect.seals[0]!.content));
    expect(writer.nip44Decrypt(writer.getPublicKey(), forWriter.content)).toBe(writer.nip44Decrypt(writer.getPublicKey(), v.expect.seals[1]!.content));
    // The reader's can't be opened by the writer's own conversation with themselves, nor the other way.
    expect(() => keyOf("session").nip44Decrypt(writer.getPublicKey(), forReader.content)).toThrow();
  });

  it("goes round: sealed here, wrapped by a world, opened here by its reader and by its writer", () => {
    const a = new NostrSigner(generatePrivateKey());
    const b = new NostrSigner(generatePrivateKey());
    const c = new NostrSigner(generatePrivateKey());
    const sealed = sealMessage(a, { to: b.getPublicKey(), text: "  Hello\u202e there\n\n\n\nyou  ", nowSeconds: 1_800_000_000 })!;
    expect(sealed.message.content).toBe("Hello there\n\nyou");
    expect(sealed.message.id).toBe(computeEventId(sealed.message));
    const want = { id: sealed.message.id, from: a.getPublicKey(), to: [b.getPublicKey()], text: "Hello there\n\nyou", at: 1_800_000_000 };
    expect(openWrap(b, wrap(sealed.seals[0], b.getPublicKey()))).toEqual(want);
    expect(openWrap(a, wrap(sealed.seals[1], a.getPublicKey()))).toEqual(want);
    // Not for anyone else, whoever it is wrapped for.
    expect(openWrap(c, wrap(sealed.seals[0], c.getPublicKey()))).toBeNull();
    expect(openWrap(c, wrap(sealed.seals[0], b.getPublicKey()))).toBeNull();
    // The reader's seal handed to the writer, and the writer's to the reader: neither opens.
    expect(openWrap(a, wrap(sealed.seals[0], a.getPublicKey()))).toBeNull();
    expect(openWrap(b, wrap(sealed.seals[1], b.getPublicKey()))).toBeNull();
  });

  it("writes nothing to oneself, to no one, or with no words", () => {
    const a = new NostrSigner(generatePrivateKey());
    const other = getPublicKeyHex(generatePrivateKey());
    expect(sealMessage(a, { to: a.getPublicKey(), text: "x", nowSeconds: 1 })).toBeNull();
    expect(sealMessage(a, { to: "not a key", text: "x", nowSeconds: 1 })).toBeNull();
    expect(sealMessage(a, { to: other, text: " ​\n ", nowSeconds: 1 })).toBeNull();
    expect(sealMessage(a, { to: other, text: 7, nowSeconds: 1 })).toBeNull();
    expect([...cleanMessage("x".repeat(5000))]).toHaveLength(MESSAGE_LIMITS.chars);
  });

  it("opens nothing that is not a wrap for this reader with a real signature", () => {
    const a = new NostrSigner(generatePrivateKey());
    const b = new NostrSigner(generatePrivateKey());
    const sealed = sealMessage(a, { to: b.getPublicKey(), text: "hello", nowSeconds: 1_800_000_000 })!;
    const good = wrap(sealed.seals[0], b.getPublicKey());
    expect(openWrap(b, good)).not.toBeNull();
    expect(openWrap(b, { ...good, kind: 1 })).toBeNull();
    expect(openWrap(b, { ...good, content: good.content.slice(0, -4) + "AAA=" })).toBeNull();
    expect(openWrap(b, { ...good, tags: [] })).toBeNull();
    expect(openWrap(b, sealed.seals[0])).toBeNull();
    expect(openWrap(b, null)).toBeNull();
    expect(openWrap(b, "wrap")).toBeNull();
  });

  it("lists where messages reach someone: a few public wss relays, each once", () => {
    expect(buildMessageRelays(["wss://relay.example/", "wss://relay.example", `${"ws"}://plain.example`, "wss://localhost", "wss://10.0.0.1", "wss://user:pw@relay.example", "wss://two.example/path"], 5)).toEqual({
      kind: 10050,
      created_at: 5,
      tags: [["relay", "wss://relay.example"], ["relay", "wss://two.example/path"]],
      content: ""
    });
    expect(buildMessageRelays(["wss://a.example", "wss://b.example", "wss://c.example", "wss://d.example", "wss://e.example"], 5)!.tags).toHaveLength(MESSAGE_LIMITS.relays);
    expect(buildMessageRelays([], 5)).toBeNull();
    expect(buildMessageRelays([`${"ws"}://plain.example`], 5)).toBeNull();
    expect(buildMessageRelays("wss://relay.example", 5)).toBeNull();
    expect(cleanMessageRelay("wss://printer.local")).toBe("");
  });

  it("reads the three messages, and what a world asks by name", () => {
    const say = (more: Record<string, unknown>) => readSignerRequest({ nswp: SIGNER_PROTOCOL, v: 1, id: "a1", ...more });
    const other = getPublicKeyHex(generatePrivateKey());
    expect(cleanMore(["messages", "follows", "keys"])).toEqual(["follows", "messages"]);
    expect(say({ t: "want", more: ["follows", "messages"] })).toEqual({ t: "wantMore", id: "a1", more: ["follows", "messages"] });
    expect(say({ t: "seal", to: other, text: " hi " })).toEqual({ t: "seal", id: "a1", to: other, text: "hi" });
    expect(say({ t: "seal", to: other, text: " " })).toBeNull();
    expect(say({ t: "seal", to: "x", text: "hi" })).toBeNull();
    expect(say({ t: "unwrap", event: { kind: 1059 } })).toEqual({ t: "unwrap", id: "a1", event: { kind: 1059 } });
    expect(say({ t: "unwrap" })).toBeNull();
    expect(say({ t: "reach", relays: ["wss://relay.example"] })).toEqual({ t: "reach", id: "a1", relays: ["wss://relay.example"] });
    expect(say({ t: "reach", relays: Array.from({ length: 9 }, () => "wss://relay.example") })).toBeNull();
    expect(say({ t: "reach", relays: "wss://relay.example" })).toBeNull();
    const frame = { nswp: HANDOFF_PROTOCOL, v: 1, nonce: "n1", t: "frame", world: "https://arcade.example", recipient: other };
    expect(readHandoffMessage({ ...frame, more: ["messages"], has: ["follows", "x"] })).toMatchObject({ more: ["messages"], has: ["follows"] });
  });

  it("is handed over only for one world by its own address: never with a family or an application", () => {
    const key = generatePrivateKey();
    const sender = generatePrivateKey();
    const recipient = generatePrivateKey();
    const to = getPublicKeyHex(recipient);
    const site = "https://arcade.bitblocks.network";
    expect(openAppHandoff(sealHandoff(key, to, sender, undefined, { site, remember: true, more: ["messages", "follows"] }), recipient).more).toEqual(["follows", "messages"]);
    expect(() => sealHandoff(key, to, sender, undefined, { site, remember: true, family: "https://*.bitblocks.network", more: ["messages"] })).toThrow();
    expect(() => sealHandoff(key, to, sender, { site, permissions: { sign: [1] } }, { site, more: ["messages"] })).toThrow();
  });

  it("can't be had any other way: a world's `sign` still refuses every kind a message is made of", () => {
    for (const kind of [13, 14, 1059, 10050]) expect(prepareForSite({ kind, content: "", tags: [] }, "https://arcade.example", 1), String(kind)).toBeNull();
  });
});
