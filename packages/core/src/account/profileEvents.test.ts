import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { RelayPool } from "../nostr/pool.js";
import { KIND_PROFILE, KIND_RELAY_LIST, KIND_DM_RELAY_LIST } from "../nostr/kinds.js";
import { buildProfileEvent, buildRelayListEvent, buildDmRelayListEvent, publishInitialProfile } from "./profileEvents.js";

describe("publishInitialProfile (§15.8, §28.1)", () => {
  let relays: MockRelay[] = [];
  let relayUrls: string[] = [];

  beforeEach(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    relayUrls = relays.map((r) => r.url);
  });

  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it("publishes default profile and relay lists for a genuinely new identity", async () => {
    const privateKey = generatePrivateKey();
    const result = await publishInitialProfile({
      everydayPrivateKey: privateKey,
      name: "river",
      generalRelays: relayUrls,
      dmRelays: relayUrls,
      discoveryRelays: []
    });

    expect(result.profilePublished).toBe(true);
    expect(result.profileSkippedExisting).toBe(false);
    expect(result.relayListSkippedExisting).toBe(false);
    expect(result.dmRelayListSkippedExisting).toBe(false);
    expect(result.relayListAcknowledgedCount).toBeGreaterThanOrEqual(2);
    expect(result.dmRelayListAcknowledgedCount).toBeGreaterThanOrEqual(2);

    const pool = new RelayPool(relayUrls);
    const pubkey = getPublicKeyHex(privateKey);
    const profile = await pool.queryQuorum({ authors: [pubkey], kinds: [KIND_PROFILE] });
    pool.closeAll();
    const content = JSON.parse(profile.outcomes.find((o) => o.events.length > 0)!.events[0]!.content);
    expect(content.name).toBe("river");
  });

  it("never overwrites an existing profile when the everyday identity is an imported nsec (§28.1)", async () => {
    const privateKey = generatePrivateKey();
    const now = Math.floor(Date.now() / 1000);

    // Simulate an nsec that already has a real profile published elsewhere, before it is
    // ever imported into BitLogin.
    const existingProfileEvent = buildProfileEvent(
      privateKey,
      { name: "realname", display_name: "Real Name", about: "An existing Nostr user", picture: "https://example.com/avatar.png" },
      now
    );
    const existingRelayListEvent = buildRelayListEvent(privateKey, [{ url: "wss://existing-relay.example", read: true, write: true }], now);
    const existingDmRelayListEvent = buildDmRelayListEvent(privateKey, ["wss://existing-dm-relay.example"], now);

    const seedPool = new RelayPool(relayUrls);
    await Promise.all([
      seedPool.publishAll(existingProfileEvent),
      seedPool.publishAll(existingRelayListEvent),
      seedPool.publishAll(existingDmRelayListEvent)
    ]);
    seedPool.closeAll();

    // BitLogin import flow now runs its default "seed a profile" step -- this must be a no-op
    // for all three, since the identity already has real data.
    const result = await publishInitialProfile({
      everydayPrivateKey: privateKey,
      name: "imported-login-name",
      generalRelays: relayUrls,
      dmRelays: relayUrls,
      discoveryRelays: []
    });

    expect(result.profilePublished).toBe(false);
    expect(result.profileSkippedExisting).toBe(true);
    expect(result.relayListSkippedExisting).toBe(true);
    expect(result.dmRelayListSkippedExisting).toBe(true);

    const pool = new RelayPool(relayUrls);
    const pubkey = getPublicKeyHex(privateKey);
    const [profile, relayList, dmRelayList] = await Promise.all([
      pool.queryQuorum({ authors: [pubkey], kinds: [KIND_PROFILE] }),
      pool.queryQuorum({ authors: [pubkey], kinds: [KIND_RELAY_LIST] }),
      pool.queryQuorum({ authors: [pubkey], kinds: [KIND_DM_RELAY_LIST] })
    ]);
    pool.closeAll();

    // The original profile survives untouched -- not replaced with "imported-login-name".
    const survivingProfile = profile.outcomes.find((o) => o.events.length > 0)!.events[0]!;
    const survivingContent = JSON.parse(survivingProfile.content);
    expect(survivingContent.name).toBe("realname");
    expect(survivingContent.about).toBe("An existing Nostr user");
    expect(survivingContent.picture).toBe("https://example.com/avatar.png");

    const survivingRelayList = relayList.outcomes.find((o) => o.events.length > 0)!.events[0]!;
    expect(survivingRelayList.tags.some((t) => t[1] === "wss://existing-relay.example")).toBe(true);

    const survivingDmRelayList = dmRelayList.outcomes.find((o) => o.events.length > 0)!.events[0]!;
    expect(survivingDmRelayList.tags.some((t) => t[1] === "wss://existing-dm-relay.example")).toBe(true);
  });
});
