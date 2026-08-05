import { describe, expect, it, afterEach, vi } from "vitest";
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
  mergeRelayLists,
  parseAndVerifyBootstrapList,
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
    expect(mergeRelayLists(["wss://pinned.example"], fetched, "vault")).toEqual(
      ["wss://pinned.example", "wss://remote.example"],
    );
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
