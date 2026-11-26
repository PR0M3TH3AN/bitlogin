import { describe, expect, it } from "vitest";
import { framesOfClient, PANEL_CLIENTS, panelClientAllowed, panelMessage, readPanelControl, readPanelHello, readPanelReply } from "./panel.js";

const REAL = "https://bitlogin.network";

describe("the sign-in panel (sign-in-window.md §SW19)", () => {
  it("is shown only by a client BitLogin lists, by exact origin", () => {
    expect(PANEL_CLIENTS).toEqual(["https://portal.bitblocks.network"]);
    expect(panelClientAllowed("https://portal.bitblocks.network", REAL)).toBe(true);
    for (const page of [
      "https://gallery.bitblocks.network",
      "https://bitblocks.network",
      "http://portal.bitblocks.network",
      "https://portal.bitblocks.network.evil.example",
      "https://evil.example",
      "http://localhost:5173",
      "null",
      ""
    ]) {
      expect(panelClientAllowed(page, REAL), page).toBe(false);
    }
  });

  it("lets a local copy be tried against a local client, and nothing else", () => {
    expect(panelClientAllowed("http://127.0.0.1:5173", "http://localhost:4173")).toBe(true);
    expect(panelClientAllowed("http://localhost:3000", "http://localhost:4173")).toBe(true);
    // This network counts as local, as it does everywhere else in BitLogin: a copy served to a phone or a headset.
    expect(panelClientAllowed("https://192.168.68.84:4300", "https://192.168.68.84:4311")).toBe(true);
    expect(panelClientAllowed("https://192.168.68.84:4300", REAL)).toBe(false);
    // A local copy does not answer the real client, nor a site on the internet.
    expect(panelClientAllowed("https://portal.bitblocks.network", "http://localhost:4173")).toBe(false);
    expect(panelClientAllowed("https://evil.example", "http://localhost:4173")).toBe(false);
  });

  it("reads a client's hello, and nothing that is not exactly one", () => {
    const hello = (m: Record<string, unknown>) => ({ bitlogin: "bitlogin-panel", v: 1, t: "hello", ...m });
    expect(readPanelHello(hello({ world: "https://gallery.bitblocks.network" }))).toEqual({ t: "hello", mode: "ask", world: "https://gallery.bitblocks.network" });
    expect(readPanelHello(hello({ world: "https://gallery.bitblocks.network/room?x=1", mode: "switch" }))).toEqual({ t: "hello", mode: "switch", world: "https://gallery.bitblocks.network" });
    expect(readPanelHello(hello({}))).toEqual({ t: "hello", mode: "account" });
    // A guest's "Secure this account", from a press at the client (docs/guest-accounts.md G6).
    expect(readPanelHello(hello({ mode: "secure" }))).toEqual({ t: "hello", mode: "secure" });
    expect(readPanelHello(hello({ mode: "account", world: "https://gallery.bitblocks.network" }))).toEqual({ t: "hello", mode: "account", world: "https://gallery.bitblocks.network" });
    // Straight to the file browser, or the wallet: no world is needed.
    expect(readPanelHello(hello({ mode: "files" }))).toEqual({ t: "hello", mode: "files" });
    expect(readPanelHello(hello({ mode: "wallet" }))).toEqual({ t: "hello", mode: "wallet" });
    expect(readPanelHello(hello({ mode: "switch" }))).toBeNull();
    // Asking for a world needs the world.
    expect(readPanelHello(hello({ mode: "ask" }))).toBeNull();
    expect(readPanelHello(hello({ world: "javascript:alert(1)" }))).toBeNull();
    expect(readPanelHello(hello({ world: "https://a.example", mode: "everything" }))).toBeNull();
    expect(readPanelHello({ ...hello({}), v: 2 })).toBeNull();
    expect(readPanelHello({ ...hello({}), bitlogin: "other" })).toBeNull();
    expect(readPanelHello(null)).toBeNull();
    expect(readPanelHello("hello")).toBeNull();
  });

  it("says only that it is ready, what size it would like, that it is done, and that the account here is gone", () => {
    expect(panelMessage({ t: "ready" })).toEqual({ bitlogin: "bitlogin-panel", v: 1, t: "ready" });
    for (const message of [{ t: "ready" }, { t: "size", size: "menu" }, { t: "size", size: "tall" }, { t: "close", allowed: true }, { t: "close", allowed: false }, { t: "gone", why: "signed-out" }, { t: "gone", why: "locked" }] as const) {
      expect(readPanelReply(panelMessage(message))).toEqual(message);
    }
    expect(readPanelReply(panelMessage({ t: "size", size: "huge" } as never))).toBeNull();
    // Gone says why in one of two words, and nothing more: anything else in it is not read.
    expect(readPanelReply(panelMessage({ t: "gone", why: "deleted" } as never))).toBeNull();
    expect(readPanelReply({ ...panelMessage({ t: "gone", why: "locked" }), pubkey: "ab" })).toEqual({ t: "gone", why: "locked" });
    // A wished height, in CSS pixels, kept within sense. The client clamps it again to what its screen allows.
    expect(readPanelReply(panelMessage({ t: "size", size: "tall", height: 541.6 }))).toEqual({ t: "size", size: "tall", height: 542 });
    expect(readPanelReply(panelMessage({ t: "size", size: "tall", height: 999999 }))).toEqual({ t: "size", size: "tall", height: 4000 });
    expect(readPanelReply(panelMessage({ t: "size", size: "menu", height: 3 }))).toEqual({ t: "size", size: "menu", height: 120 });
    expect(readPanelReply({ bitlogin: "bitlogin-panel", v: 1, t: "size", size: "menu", height: "tall" })).toEqual({ t: "size", size: "menu" });
    expect(readPanelReply({ bitlogin: "bitlogin-panel", v: 1, t: "close", allowed: "yes" })).toEqual({ t: "close", allowed: false });
    expect(readPanelReply({ bitlogin: "bitlogin-panel", v: 1, t: "key", key: "x" })).toBeNull();
  });

  it("looks in the client's frames and theirs, two levels and no deeper, and never at itself", () => {
    const deep = { frames: { length: 0 } } as unknown as Window;
    const signer = { frames: Object.assign([deep], { length: 1 }) } as unknown as Window;
    const world = { frames: Object.assign([signer], { length: 1 }) } as unknown as Window;
    const other = { frames: Object.assign([], { length: 0 }) } as unknown as Window;
    const panel: { parent?: Window } = {};
    const client = { frames: Object.assign([world, panel, other], { length: 3 }) } as unknown as Window;
    panel.parent = client;
    expect(framesOfClient(panel as unknown as Window)).toEqual([world, signer, other]);
  });
});

describe("the panel, opened for what a person has bought (docs/paying.md)", () => {
  it("takes the mode, with no world", () => {
    expect(readPanelHello({ bitlogin: "bitlogin-panel", v: 1, t: "hello", mode: "library" })).toEqual({ t: "hello", mode: "library" });
  });
});

describe("a panel the client keeps, shown again and hidden (sign-in-window.md §SW19.8)", () => {
  const msg = (rest: Record<string, unknown>) => ({ bitlogin: "bitlogin-panel", v: 1, ...rest });
  it("reads show, with a mode and a world as a hello has them, and hide", () => {
    expect(readPanelControl(msg({ t: "show", mode: "wallet" }))).toEqual({ t: "show", mode: "wallet" });
    expect(readPanelControl(msg({ t: "show", mode: "secure" }))).toEqual({ t: "show", mode: "secure" });
    expect(readPanelControl(msg({ t: "show", world: "https://gallery.bitblocks.network/x" }))).toEqual({ t: "show", mode: "ask", world: "https://gallery.bitblocks.network" });
    expect(readPanelControl(msg({ t: "hide", mode: "wallet" }))).toEqual({ t: "hide" });
    for (const bad of [msg({ t: "show", mode: "nonsense" }), msg({ t: "show", mode: "ask" }), msg({ t: "hello", mode: "wallet" }), { t: "show", mode: "wallet" }, msg({ t: "show", mode: "wallet", v: 2 }), null]) expect(readPanelControl(bad)).toBeNull();
  });
});
