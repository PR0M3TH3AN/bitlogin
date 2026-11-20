import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { signNostrEvent } from "@bitlogin/core/nostr";
import { NEVER_KINDS, prepareForSite, readSignerRequest, signClass } from "./policy.js";
import { buildRoomPass, cleanAbout, cleanPicture, newestProfile, profileFromMetadata, PROFILE_LIMITS, readProfile, ROOM_PASS_KIND } from "./profile.js";
import { openAppHandoff, sealHandoff } from "../worker/handoff.js";

const key = generatePrivateKey();
const me = getPublicKeyHex(key);
const kind0 = (content: unknown, created_at = 1_800_000_000, by = key) =>
  signNostrEvent({ kind: 0, pubkey: getPublicKeyHex(by), created_at, tags: [], content: typeof content === "string" ? content : JSON.stringify(content) }, by);

describe("who someone is (§SW16)", () => {
  it("takes a picture only from an https address with no credentials in it", () => {
    expect(cleanPicture("https://pictures.example/a.png")).toBe("https://pictures.example/a.png");
    for (const bad of ["http://pictures.example/a.png", "https://user:pw@pictures.example/a.png", "https://localhost/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", `https://pictures.example/${"a".repeat(300)}`, 7, null]) {
      expect(cleanPicture(bad), String(bad)).toBe("");
    }
  });

  it("makes what someone wrote about themselves one plain line of at most 280 characters", () => {
    expect(cleanAbout("  Line one\n\nline\ttwo \u202e reversed \u200b ")).toBe("Line one line two reversed");
    expect([...cleanAbout("x".repeat(5000))].length).toBe(PROFILE_LIMITS.aboutChars);
    expect(cleanAbout({})).toBe("");
  });

  it("reads a profile part by part, and is nothing when nothing is left", () => {
    expect(readProfile({ name: " Ada ", picture: "http://no.example/x.png", about: "" })).toEqual({ name: "Ada" });
    expect(readProfile({ name: "\u200b", picture: "nope" })).toBeNull();
    expect(readProfile("Ada")).toBeNull();
    expect(readProfile(["Ada"])).toBeNull();
  });

  it("believes a profile only as far as its signature goes", () => {
    const event = kind0({ name: "Ada", display_name: "Countess", picture: "https://pictures.example/ada.png", about: "Notes." });
    expect(profileFromMetadata(event, me)).toEqual({ name: "Countess", picture: "https://pictures.example/ada.png", about: "Notes." });
    // Somebody else's profile, a changed one, another kind, and content that is not a profile.
    expect(profileFromMetadata(event, getPublicKeyHex(generatePrivateKey()))).toBeNull();
    expect(profileFromMetadata({ ...event, content: JSON.stringify({ name: "Mallory" }) }, me)).toBeNull();
    expect(profileFromMetadata(signNostrEvent({ kind: 1, pubkey: me, created_at: 1, tags: [], content: JSON.stringify({ name: "Ada" }) }, key), me)).toBeNull();
    expect(profileFromMetadata(kind0("not json"), me)).toBeNull();
    expect(profileFromMetadata(kind0([1, 2]), me)).toBeNull();
    // The display name comes first, then the older spelling, then the short name.
    expect(profileFromMetadata(kind0({ display_name: "Countess" }), me)).toEqual({ name: "Countess" });
    expect(profileFromMetadata(kind0({ name: "Ada", displayName: "Lovelace" }), me)).toEqual({ name: "Lovelace" });
    expect(profileFromMetadata(kind0({ name: "Ada", display_name: "​", displayName: " " }), me)).toEqual({ name: "Ada" });
    expect(profileFromMetadata(kind0({ name: "Ada", display_name: 7 }), me)).toEqual({ name: "Ada" });
  });

  it("takes the newest profile their own key signed, even when that one says nothing", () => {
    const stranger = generatePrivateKey();
    const events = [kind0({ name: "Old" }, 100), kind0({ name: "New" }, 300), kind0({ name: "Forged" }, 900, stranger), { ...kind0({ name: "Tampered" }, 950), created_at: 951 }, "junk"];
    expect(newestProfile(events, me)).toEqual({ name: "New" });
    // A newer profile with nothing usable in it replaces the older one: an emptied profile stays emptied.
    expect(newestProfile([...events, kind0({}, 400)], me)).toBeNull();
    expect(newestProfile([], me)).toBeNull();
  });
});

describe("a room pass (§SW16)", () => {
  const session = getPublicKeyHex(generatePrivateKey());
  const site = "https://world.example";

  it("is the signer's own in every part but the session key", () => {
    const pass = buildRoomPass({ session, site: `${site}/room/7?x=1`, identity: me, nowSeconds: 1_800_000_000.9, profile: { name: "Ada", picture: "https://pictures.example/ada.png", about: "Notes." } });
    expect(pass).toEqual({
      kind: ROOM_PASS_KIND,
      created_at: 1_800_000_000,
      content: "",
      tags: [
        ["nswp:session", session],
        ["nswp:origin", site],
        ["expiration", String(1_800_000_000 + 4 * 3600)],
        ["name", "Ada"],
        ["picture", "https://pictures.example/ada.png"],
        ["about", "Notes."]
      ]
    });
  });

  it("cleans a profile again as it goes in, and leaves out what there is none of", () => {
    const pass = buildRoomPass({ session, site, identity: me, nowSeconds: 10, profile: { name: "A\u202eda", picture: "http://plain.example/x.png" } as never });
    expect(pass?.tags.slice(3)).toEqual([["name", "A da"]]);
    expect(buildRoomPass({ session, site, identity: me, nowSeconds: 10 })?.tags).toHaveLength(3);
  });

  it("is not made without a site, for something that is no key, or for the identity key itself", () => {
    expect(buildRoomPass({ session, site: "", identity: me, nowSeconds: 10 })).toBeNull();
    expect(buildRoomPass({ session, site: "ftp://world.example", identity: me, nowSeconds: 10 })).toBeNull();
    expect(buildRoomPass({ session: session.toUpperCase(), site, identity: me, nowSeconds: 10 })).toBeNull();
    expect(buildRoomPass({ session: { toString: () => session }, site, identity: me, nowSeconds: 10 })).toBeNull();
    expect(buildRoomPass({ session: me, site, identity: me, nowSeconds: 10 })).toBeNull();
  });

  it("is asked for with a session key and nothing else, and never through sign", () => {
    const ask = (more: Record<string, unknown>) => readSignerRequest({ nswp: "nswp-signer", v: 1, id: "a1", t: "pass", ...more });
    // Whatever else a site sends with it is not read.
    expect(ask({ session, origin: "https://elsewhere.example", name: "Somebody Else", ttl: 999_999 })).toEqual({ t: "pass", id: "a1", session });
    expect(ask({ session: "nope" })).toBeNull();
    expect(ask({})).toBeNull();
    // The never-sign list is as it was: a pass does not go through "sign".
    expect(NEVER_KINDS).toContain(ROOM_PASS_KIND);
    expect(signClass(ROOM_PASS_KIND)).toBe("never");
    expect(prepareForSite({ kind: ROOM_PASS_KIND, content: "", tags: [["nswp:session", session]] }, site, 10)).toBeNull();
  });
});

describe("the site and the profile inside a sealed hand-off (§SW16)", () => {
  const everyday = generatePrivateKey();
  const recipient = generatePrivateKey();
  const to = getPublicKeyHex(recipient);

  it("carries both, read again on each side", () => {
    const sealed = sealHandoff(everyday, to, generatePrivateKey(), undefined, { site: "https://world.example", profile: { name: " Ada ", picture: "http://no.example/x.png" } });
    const opened = openAppHandoff(sealed, recipient);
    expect(opened.app).toBeNull();
    expect(opened.site).toBe("https://world.example");
    expect(opened.profile).toEqual({ name: "Ada" });
  });

  it("names no site and no profile when given none", () => {
    const opened = openAppHandoff(sealHandoff(everyday, to, generatePrivateKey()), recipient);
    expect(opened.site).toBeNull();
    expect(opened.profile).toBeNull();
  });

  it("will not seal for something that is no site, or for a site other than the application's", () => {
    expect(() => sealHandoff(everyday, to, generatePrivateKey(), undefined, { site: "https://world.example/path" })).toThrow(/usable site/u);
    expect(() => sealHandoff(everyday, to, generatePrivateKey(), undefined, { site: 7 })).toThrow(/usable site/u);
    const app = { site: "https://app.example", permissions: { name: "App", sign: [1] } };
    expect(() => sealHandoff(everyday, to, generatePrivateKey(), app, { site: "https://other.example" })).toThrow(/usable site/u);
    expect(openAppHandoff(sealHandoff(everyday, to, generatePrivateKey(), app, { site: "https://app.example" }), recipient).site).toBe("https://app.example");
  });
});
