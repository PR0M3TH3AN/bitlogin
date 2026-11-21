import { describe, expect, it } from "vitest";
import { framesOfClient, PANEL_CLIENTS, panelClientAllowed, panelMessage, readPanelHello, readPanelReply } from "./panel.js";

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
    expect(readPanelHello(hello({ mode: "account", world: "https://gallery.bitblocks.network" }))).toEqual({ t: "hello", mode: "account", world: "https://gallery.bitblocks.network" });
    // Asking for a world needs the world.
    expect(readPanelHello(hello({ mode: "ask" }))).toBeNull();
    expect(readPanelHello(hello({ world: "javascript:alert(1)" }))).toBeNull();
    expect(readPanelHello(hello({ world: "https://a.example", mode: "everything" }))).toBeNull();
    expect(readPanelHello({ ...hello({}), v: 2 })).toBeNull();
    expect(readPanelHello({ ...hello({}), bitlogin: "other" })).toBeNull();
    expect(readPanelHello(null)).toBeNull();
    expect(readPanelHello("hello")).toBeNull();
  });

  it("says only that it is ready, what size it would like, and that it is done", () => {
    expect(panelMessage({ t: "ready" })).toEqual({ bitlogin: "bitlogin-panel", v: 1, t: "ready" });
    for (const message of [{ t: "ready" }, { t: "size", size: "menu" }, { t: "size", size: "tall" }, { t: "close", allowed: true }, { t: "close", allowed: false }] as const) {
      expect(readPanelReply(panelMessage(message))).toEqual(message);
    }
    expect(readPanelReply(panelMessage({ t: "size", size: "huge" } as never))).toBeNull();
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
