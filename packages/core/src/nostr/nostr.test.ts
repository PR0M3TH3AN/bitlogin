import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { InMemoryKeyValueStore } from "../storage/interface.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import {
  compareNip01ReplacementOrder,
  signNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
} from "./event.js";
import { D_TAG_BOOTSTRAP_RELAYS, KIND_APP_DATA } from "./kinds.js";
import {
  fetchRelayInfo,
  matchesNostrFilter,
  RelayConnection,
  type NostrFilter,
} from "./relay.js";
import { RelayPool } from "./pool.js";
import { MockRelay } from "../test-support/mockRelay.js";
import {
  BUILTIN_DISCOVERY_RELAYS,
  BUILTIN_VAULT_RELAYS,
  MAINTAINER_PUBLIC_KEY_HEX,
  WRITE_HOSTILE_RELAYS,
  buildBootstrapListEvent,
  fetchBootstrapListFromRelays,
  loadCachedBootstrapList,
  maxRemoteAdditions,
  mergeRelayLists,
  parseAndVerifyBootstrapList,
  refreshBootstrapList,
  type BootstrapRelayList,
} from "./bootstrap.js";

describe("NIP-01 event id/sign/verify", () => {
  it("signs an event and verifies it", () => {
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      {
        pubkey,
        created_at: 1700000000,
        kind: KIND_APP_DATA,
        tags: [["d", "bitlogin:password:v1"]],
        content: "hello",
      },
      sk,
    );
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("rejects a tampered event", () => {
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      {
        pubkey,
        created_at: 1700000000,
        kind: KIND_APP_DATA,
        tags: [["d", "x"]],
        content: "hello",
      },
      sk,
    );
    const tampered = { ...event, content: "goodbye" };
    expect(verifyNostrEvent(tampered)).toBe(false);
  });

  it.each([
    null,
    undefined,
    [],
    "event",
    1,
    {},
    { id: "a".repeat(64) },
    {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      sig: "c".repeat(128),
      created_at: 1,
      kind: 1,
      tags: [null],
      content: "",
    },
    {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      sig: "c".repeat(128),
      created_at: -1,
      kind: 1,
      tags: [],
      content: "",
    },
    {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      sig: "c".repeat(128),
      created_at: 1,
      kind: 65_536,
      tags: [],
      content: "",
    },
  ])(
    "totally rejects malformed runtime input without throwing: %j",
    (candidate) => {
      expect(() => verifyNostrEvent(candidate)).not.toThrow();
      expect(verifyNostrEvent(candidate)).toBe(false);
    },
  );

  it("uses NIP-01 replacement ordering: newer timestamp, then lower id", () => {
    expect(
      compareNip01ReplacementOrder(
        { created_at: 2, id: "f" },
        { created_at: 1, id: "0" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareNip01ReplacementOrder(
        { created_at: 1, id: "0" },
        { created_at: 1, id: "f" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareNip01ReplacementOrder(
        { created_at: 1, id: "f" },
        { created_at: 1, id: "0" },
      ),
    ).toBeLessThan(0);
    expect(
      compareNip01ReplacementOrder(
        { created_at: 1, id: "0" },
        { created_at: 1, id: "0" },
      ),
    ).toBe(0);
  });
});

describe("NIP-01 local subscription-filter enforcement", () => {
  const signer = generatePrivateKey();
  const pubkey = getPublicKeyHex(signer);
  const base = {
    pubkey,
    created_at: 100,
    kind: KIND_APP_DATA,
    tags: [
      ["d", "wanted"],
      ["e", "parent"],
    ],
    content: "ok",
  };
  const event = signNostrEvent(base, signer);
  const filter: NostrFilter = {
    ids: [event.id.slice(0, 16)],
    authors: [pubkey.slice(0, 16)],
    kinds: [KIND_APP_DATA],
    since: 100,
    until: 100,
    "#d": ["wanted"],
    "#e": ["parent"],
  };

  it("accepts an event matching every requested dimension", () => {
    expect(matchesNostrFilter(event, filter)).toBe(true);
  });

  it.each([
    ["id", { ...filter, ids: ["f".repeat(64)] }],
    ["author", { ...filter, authors: ["f".repeat(64)] }],
    ["kind", { ...filter, kinds: [1] }],
    ["since", { ...filter, since: 101 }],
    ["until", { ...filter, until: 99 }],
    ["d tag", { ...filter, "#d": ["other"] }],
    ["e tag", { ...filter, "#e": ["other"] }],
  ] satisfies Array<[string, NostrFilter]>)(
    "rejects a valid signed event with the wrong %s",
    (_label, wrongFilter) => {
      expect(matchesNostrFilter(event, wrongFilter)).toBe(false);
    },
  );
});

describe("relay transport policy", () => {
  it("rejects a non-WebSocket NIP-11 target before fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("must not be called"));
    try {
      await expect(fetchRelayInfo("http://relay.example")).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("RelayConnection + MockRelay", () => {
  let relay: MockRelay;

  afterEach(async () => {
    await relay?.close();
  });

  it("publishes and reads back an addressable kind-30078 event", async () => {
    relay = await MockRelay.start();
    const conn = new RelayConnection(relay.url);
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      {
        pubkey,
        created_at: 1700000000,
        kind: KIND_APP_DATA,
        tags: [["d", "bitlogin:password:v1"]],
        content: "ciphertext",
      },
      sk,
    );
    const result = await conn.publish(event);
    expect(result.ok).toBe(true);

    const found = await conn.queryOnce({
      kinds: [KIND_APP_DATA],
      authors: [pubkey],
      "#d": ["bitlogin:password:v1"],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(event.id);
    conn.close();
  });

  it("replaces an addressable event only with a newer created_at (NIP-01 replacement)", async () => {
    relay = await MockRelay.start();
    const conn = new RelayConnection(relay.url);
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const older = signNostrEvent(
      {
        pubkey,
        created_at: 1000,
        kind: KIND_APP_DATA,
        tags: [["d", "bitlogin:recovery:v1"]],
        content: "gen1",
      },
      sk,
    );
    const newer = signNostrEvent(
      {
        pubkey,
        created_at: 2000,
        kind: KIND_APP_DATA,
        tags: [["d", "bitlogin:recovery:v1"]],
        content: "gen2",
      },
      sk,
    );
    await conn.publish(newer);
    await conn.publish(older); // stale replay attempt, must not win
    const found = await conn.queryOnce({
      kinds: [KIND_APP_DATA],
      authors: [pubkey],
      "#d": ["bitlogin:recovery:v1"],
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe("gen2");
    conn.close();
  });

  it("drops malformed and valid-but-out-of-filter EVENT frames from a malicious relay", async () => {
    relay = await MockRelay.start();
    const conn = new RelayConnection(relay.url);
    const sk = generatePrivateKey();
    const otherSk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const wanted = signNostrEvent(
      {
        pubkey,
        created_at: 100,
        kind: KIND_APP_DATA,
        tags: [["d", "wanted"]],
        content: "wanted",
      },
      sk,
    );
    const variants: NostrEvent[] = [
      signNostrEvent(
        {
          ...wanted,
          pubkey: getPublicKeyHex(otherSk),
          content: "wrong author",
        },
        otherSk,
      ),
      signNostrEvent({ ...wanted, kind: 1, content: "wrong kind" }, sk),
      signNostrEvent(
        { ...wanted, tags: [["d", "wrong"]], content: "wrong tag" },
        sk,
      ),
      signNostrEvent({ ...wanted, created_at: 99, content: "too old" }, sk),
      signNostrEvent({ ...wanted, created_at: 101, content: "too new" }, sk),
      signNostrEvent({ ...wanted, content: "wrong id" }, sk),
    ];
    relay.unsolicitedQueryEvents = [null, ...variants, wanted];

    const found = await conn.queryOnce({
      ids: [wanted.id],
      authors: [pubkey],
      kinds: [KIND_APP_DATA],
      since: 100,
      until: 100,
      "#d": ["wanted"],
    });
    expect(found.map((candidate) => candidate.id)).toEqual([wanted.id]);
    conn.close();
  });
});

describe("signed bootstrap relay updates", () => {
  const maintainerKey = generatePrivateKey();
  const maintainerPubkey = getPublicKeyHex(maintainerKey);

  function signedList(list: BootstrapRelayList): NostrEvent {
    return signNostrEvent(
      {
        pubkey: maintainerPubkey,
        created_at: 100,
        kind: KIND_APP_DATA,
        tags: [["d", D_TAG_BOOTSTRAP_RELAYS]],
        content: JSON.stringify(list),
      },
      maintainerKey,
    );
  }

  it("is explicitly disabled when no real maintainer key is pinned", () => {
    expect(MAINTAINER_PUBLIC_KEY_HEX).toBeNull();
    expect(
      parseAndVerifyBootstrapList(
        signedList({ version: 1, vaultRelays: [], discoveryRelays: [] }),
      ),
    ).toBeNull();
    expect(
      parseAndVerifyBootstrapList(
        signedList({ version: 1, vaultRelays: [], discoveryRelays: [] }),
        "0".repeat(64),
      ),
    ).toBeNull();
  });

  it("validates relay URLs, field shapes, and monotonic versions", () => {
    const valid = signedList({
      version: 2,
      vaultRelays: ["wss://vault.example"],
      discoveryRelays: ["wss://discovery.example"],
      deprecated: ["wss://old.example"],
    });
    expect(
      parseAndVerifyBootstrapList(valid, maintainerPubkey, 1)?.version,
    ).toBe(2);
    expect(parseAndVerifyBootstrapList(valid, maintainerPubkey, 2)).toBeNull();
    expect(
      parseAndVerifyBootstrapList(
        signedList({
          version: 3,
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- rejected transport-policy fixture
          vaultRelays: ["ws://relay.example"],
          discoveryRelays: [],
        }),
        maintainerPubkey,
        2,
      ),
    ).toBeNull();
    expect(
      parseAndVerifyBootstrapList(
        signedList({
          version: 3,
          vaultRelays: ["wss://duplicate.example", "wss://duplicate.example"],
          discoveryRelays: [],
        }),
        maintainerPubkey,
        2,
      ),
    ).toBeNull();
  });

  it("never lets a signed update remove a pinned built-in relay", () => {
    const fetched: BootstrapRelayList = {
      version: 1,
      vaultRelays: ["wss://remote.example", "wss://retired-remote.example"],
      discoveryRelays: [],
      deprecated: ["wss://pinned.example", "wss://retired-remote.example"],
    };
    // Two pinned relays, because a signed list may add at most one fewer
    // relay than the client pins (see the quorum test below).
    expect(
      mergeRelayLists(
        ["wss://pinned.example", "wss://also-pinned.example"],
        fetched,
        "vault",
      ),
    ).toEqual([
      "wss://pinned.example",
      "wss://also-pinned.example",
      "wss://remote.example",
    ]);
  });

  it("never lets a signed list add enough relays to form a read quorum on its own", () => {
    // Reads need ceil(N/2) relays to answer. If additions could reach half of
    // N, whoever holds the maintainer key could answer the quorum with relays
    // they run, and a new device would believe them.
    const pinned = ["wss://a.example", "wss://b.example", "wss://c.example"];
    const hostile = Array.from({ length: 40 }, (_, i) => `wss://hostile-${i}.example`);
    const merged = mergeRelayLists(
      pinned,
      { version: 1, vaultRelays: hostile, discoveryRelays: [] },
      "vault",
    );
    const added = merged.filter((url) => !pinned.includes(url));
    expect(added).toEqual(hostile.slice(0, 2));
    expect(added.length).toBeLessThan(Math.ceil(merged.length / 2));
    expect(merged.slice(0, 3)).toEqual(pinned);
    expect(maxRemoteAdditions(BUILTIN_VAULT_RELAYS.length)).toBe(BUILTIN_VAULT_RELAYS.length - 1);
    // A single pinned relay leaves no room to add any.
    expect(mergeRelayLists(["wss://only.example"], { version: 1, vaultRelays: hostile, discoveryRelays: [] }, "vault")).toEqual(["wss://only.example"]);
  });
});

describe("signed relay list over relays (§19.1)", () => {
  let relays: MockRelay[] = [];
  let urls: string[] = [];
  const maintainerKey = generatePrivateKey();
  const maintainerPubkey = getPublicKeyHex(maintainerKey);
  const list = (version: number, extra: string[] = []): BootstrapRelayList => ({
    version,
    vaultRelays: ["wss://added-vault.example", ...extra],
    discoveryRelays: ["wss://added-discovery.example"],
  });
  const publishTo = async (target: MockRelay, event: NostrEvent) => {
    const pool = new RelayPool([target.url]);
    await pool.publishAll(event);
    pool.closeAll();
  };

  beforeEach(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    urls = relays.map((r) => r.url);
  });
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it("returns the highest version any relay holds, and nothing from another signer", async () => {
    await publishTo(relays[0]!, buildBootstrapListEvent(list(2), maintainerKey, 1_800_000_000));
    await publishTo(relays[1]!, buildBootstrapListEvent(list(5), maintainerKey, 1_800_000_100));
    // A forger can publish at the same address under their own key; it is not the maintainer's.
    await publishTo(relays[2]!, buildBootstrapListEvent(list(99), generatePrivateKey(), 1_800_000_200));

    const found = await fetchBootstrapListFromRelays(urls, maintainerPubkey);
    expect(found?.list.version).toBe(5);
    expect(found?.event.pubkey).toBe(maintainerPubkey);
    // No key pinned means the channel is off, whatever the relays hold.
    expect(await fetchBootstrapListFromRelays(urls, null)).toBeNull();
  });

  it("refuses a list that is not newer than the one this device already accepted", async () => {
    await publishTo(relays[0]!, buildBootstrapListEvent(list(3), maintainerKey));
    expect(await fetchBootstrapListFromRelays(urls, maintainerPubkey, 3)).toBeNull();
    expect((await fetchBootstrapListFromRelays(urls, maintainerPubkey, 2))?.list.version).toBe(3);
  });

  it("refreshes, remembers the list, and cannot be rolled back by a relay serving an old one", async () => {
    const store = new InMemoryKeyValueStore();
    const options = { maintainerPubkeyHex: maintainerPubkey, queryRelayUrls: urls };
    expect((await refreshBootstrapList(store, options)).listVersion).toBeNull();

    for (const relay of relays) await publishTo(relay, buildBootstrapListEvent(list(4), maintainerKey, 1_800_000_000));
    const sets = await refreshBootstrapList(store, options);
    expect(sets.listVersion).toBe(4);
    expect(sets.vaultRelays.slice(0, BUILTIN_VAULT_RELAYS.length)).toEqual([...BUILTIN_VAULT_RELAYS]);
    expect(sets.vaultRelays).toContain("wss://added-vault.example");
    expect(sets.discoveryRelays).toContain("wss://added-discovery.example");

    // Every relay loses the new list and one replays a genuine older one.
    for (const relay of relays) relay.wipeAllData();
    await publishTo(relays[0]!, buildBootstrapListEvent(list(1, ["wss://stale.example"]), maintainerKey, 1_700_000_000));
    const after = await refreshBootstrapList(store, options);
    expect(after.listVersion).toBe(4);
    expect(after.vaultRelays).not.toContain("wss://stale.example");
    expect((await loadCachedBootstrapList(store, maintainerPubkey))?.version).toBe(4);
  });

  it("ignores a cached list that does not verify against the pinned key", async () => {
    const store = new InMemoryKeyValueStore();
    await refreshBootstrapList(store, { maintainerPubkeyHex: maintainerPubkey, queryRelayUrls: urls });
    await store.set("bitlogin:bootstrap-relays:v1", JSON.stringify(buildBootstrapListEvent(list(7), generatePrivateKey())));
    expect(await loadCachedBootstrapList(store, maintainerPubkey)).toBeNull();
    await store.set("bitlogin:bootstrap-relays:v1", "{not json");
    expect(await loadCachedBootstrapList(store, maintainerPubkey)).toBeNull();
    // With no key pinned, nothing is fetched and the built-in lists apply unchanged.
    const off = await refreshBootstrapList(store, { maintainerPubkeyHex: null, queryRelayUrls: urls });
    expect(off).toEqual({ vaultRelays: [...BUILTIN_VAULT_RELAYS], discoveryRelays: [...BUILTIN_DISCOVERY_RELAYS], listVersion: null });
  });

  it("refuses to sign a list a client would reject", () => {
    expect(() => buildBootstrapListEvent({ version: 1, vaultRelays: ["ws://plain.example"], discoveryRelays: [] }, maintainerKey)).toThrow(/not valid/u);
    expect(() => buildBootstrapListEvent({ version: 0, vaultRelays: [], discoveryRelays: [] }, maintainerKey)).toThrow(/not valid/u);
  });
});

describe("RelayPool quorum", () => {
  let relays: MockRelay[] = [];

  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
    relays = [];
  });

  it("reports quorum met when a majority of relays respond", async () => {
    relays = await Promise.all([
      MockRelay.start(),
      MockRelay.start(),
      MockRelay.start(),
    ]);
    const pool = new RelayPool(relays.map((r) => r.url));
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      {
        pubkey,
        created_at: 1700000000,
        kind: KIND_APP_DATA,
        tags: [["d", "bitlogin:password:v1"]],
        content: "x",
      },
      sk,
    );
    await pool.publishAll(event);
    const result = await pool.queryQuorum({
      kinds: [KIND_APP_DATA],
      authors: [pubkey],
      "#d": ["bitlogin:password:v1"],
    });
    expect(result.quorumMet).toBe(true);
    expect(result.respondedCount).toBe(3);
    const withEvents = result.outcomes.filter((o) => o.events.length > 0);
    expect(withEvents).toHaveLength(3);
    pool.closeAll();
  });
});

/*
 * The built-in relay lists are a shipped configuration that decides whether a
 * user can create an account at all, so they get the same treatment as any
 * other invariant: pinned, with the reasoning attached.
 *
 * Hermetic on purpose -- no relay is contacted here. Reachability is a
 * property of the network the user is on and cannot be asserted in CI;
 * WRITE POLICY is a property of the relay and can.
 */
describe("built-in relay lists", () => {
  it("keeps write-hostile relays out of the vault (publish) list", () => {
    // nostr.wine advertises payment_required + restricted_writes in its own
    // NIP-11 document, so it can never accept a free user's capsule. It sat
    // in this list occupying one of five write slots it could not fill.
    for (const hostile of WRITE_HOSTILE_RELAYS) {
      expect(BUILTIN_VAULT_RELAYS).not.toContain(hostile);
    }
  });

  it("leaves enough margin over the publish floor to lose relays", () => {
    // publishAndVerify enforces minAcks/minReadbacks = 2 regardless of list
    // size. Two usable relays against a floor of two is zero margin: one
    // unreachable relay fails registration outright. Require room to lose
    // several and still clear the floor.
    expect(BUILTIN_VAULT_RELAYS.length).toBeGreaterThanOrEqual(6);
  });

  it("ships no duplicates and only secure websocket URLs", () => {
    for (const list of [BUILTIN_VAULT_RELAYS, BUILTIN_DISCOVERY_RELAYS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const url of list) expect(url.startsWith("wss://")).toBe(true);
    }
  });
});
