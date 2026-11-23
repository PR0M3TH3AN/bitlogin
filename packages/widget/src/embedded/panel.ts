/**
 * The sign-in panel (docs/sign-in-window.md §SW19): BitLogin's own page,
 * shown in a frame by a client that keeps the screen (BitPortal's shell), in
 * place of the sign-in window, so that a visitor never leaves the world.
 *
 * This is the part with no interface: who may show the panel, and the few
 * words the panel and the page that shows it say to each other. They carry
 * nothing about the visitor: no key, no name, no account. What the panel
 * does for a world it does by speaking to BitLogin's own signer frame inside
 * that world, exactly as the window does (embedded/window.ts).
 */
import { isLocalAddress } from "./permissions.js";
import { cleanOrigin } from "./policy.js";

export const PANEL_PROTOCOL = "bitlogin-panel";
export const PANEL_VERSION = 1;

/**
 * The pages that may show the panel, by exact origin. The deployment's
 * `frame-ancestors` for /connect/panel/ is this list and nothing else (a test
 * pins the two together). Never `https:`, and never a world: a page that
 * frames the panel can cover it, shrink it, or slide it under a press. Only a
 * client the owner runs is trusted with that, and it is a top-level page a
 * world inside it can't script.
 */
export const PANEL_CLIENTS: readonly string[] = ["https://portal.bitblocks.network"];

/**
 * Whether `client` may show the panel served from `me`. A listed client, and
 * otherwise only where both are local addresses (this machine, or a private
 * network range: the same rule as `isLocalAddress` everywhere else): a local
 * copy of BitLogin tried against a local copy of a client. The real address
 * never accepts a local page, and a local copy accepts no page on the
 * internet. The deployment's `frame-ancestors` still has to let the client
 * in: whoever serves a local copy sets that header for it.
 */
export function panelClientAllowed(client: string, me: string): boolean {
  const c = cleanOrigin(client);
  if (!c) return false;
  if (isLocalAddress(me)) return isLocalAddress(c);
  return PANEL_CLIENTS.includes(c);
}

/** What the panel is opened for. */
/**
 * "ask": a world asked something. "switch": the account chooser, for a world. "account": the account pages.
 * "files", "wallet" and "library": straight to the person's file browser, their ecash wallet, or what they have
 * bought, with no world.
 */
export type PanelMode = "ask" | "switch" | "account" | "files" | "wallet" | "library";

/** What the client says to the panel: which world asked, and what for. */
export interface PanelHello {
  t: "hello";
  /** The world the panel is for, as the client knows it. The panel shows only a signer that reports this world. */
  world?: string;
  mode: PanelMode;
}

/**
 * What a client says to a panel it keeps (docs/sign-in-window.md §SW19.8): show it again, in a mode, or it has been
 * hidden. Only from the client that said hello, at its exact origin.
 */
export type PanelControl = ({ t: "show" } & Omit<PanelHello, "t">) | { t: "hide" };

/** Read a client's `show` or `hide`. A `show` names a mode and a world exactly as a hello does. */
export function readPanelControl(data: unknown): PanelControl | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.bitlogin !== PANEL_PROTOCOL || d.v !== PANEL_VERSION) return null;
  if (d.t === "hide") return { t: "hide" };
  if (d.t !== "show") return null;
  const asHello = readPanelHello({ ...d, t: "hello" });
  if (!asHello) return null;
  const { t: _hello, ...rest } = asHello;
  return { t: "show", ...rest };
}

/** What the panel says to the client. */
export type PanelToClient =
  /** It has loaded and heard the client. */
  | { t: "ready" }
  /**
   * The size it would like: the menu's own, or taller for the account pages; and, where it knows, how tall its
   * content is, in CSS pixels, so a short page is not shown with empty space under it. The client decides, and
   * clamps both. Sent again when the content's height changes.
   */
  | { t: "size"; size: "menu" | "tall"; height?: number }
  /** Done: close it. `allowed` says whether the world was allowed. The world learns more from its own signer. */
  | { t: "close"; allowed: boolean }
  /**
   * The account here is signed out, or locked: a client keeping this panel between openings should let it go now
   * (sign-in-window.md §SW19.8). Sent whether the panel is shown or hidden. It says nothing about the account.
   */
  | { t: "gone"; why: "signed-out" | "locked" };

export function panelMessage(message: PanelToClient | PanelHello): Record<string, unknown> {
  return { bitlogin: PANEL_PROTOCOL, v: PANEL_VERSION, ...message };
}

/** Read what a client said. Anything that is not exactly a hello is nothing. */
export function readPanelHello(data: unknown): PanelHello | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.bitlogin !== PANEL_PROTOCOL || d.v !== PANEL_VERSION || d.t !== "hello") return null;
  const mode = d.mode === undefined ? (d.world === undefined ? "account" : "ask") : d.mode;
  if (mode !== "ask" && mode !== "switch" && mode !== "account" && mode !== "files" && mode !== "wallet" && mode !== "library") return null;
  let world: string | undefined;
  if (d.world !== undefined) {
    world = cleanOrigin(d.world);
    if (!world) return null;
  }
  if ((mode === "ask" || mode === "switch") && !world) return null;
  return { t: "hello", mode, ...(world ? { world } : {}) };
}

/** Read what the panel said, for a client. */
export function readPanelReply(data: unknown): PanelToClient | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.bitlogin !== PANEL_PROTOCOL || d.v !== PANEL_VERSION) return null;
  if (d.t === "ready") return { t: "ready" };
  if (d.t === "size" && (d.size === "menu" || d.size === "tall")) {
    const height = typeof d.height === "number" && Number.isFinite(d.height) ? Math.min(4000, Math.max(120, Math.round(d.height))) : null;
    return { t: "size", size: d.size, ...(height ? { height } : {}) };
  }
  if (d.t === "close") return { t: "close", allowed: d.allowed === true };
  if (d.t === "gone" && (d.why === "signed-out" || d.why === "locked")) return { t: "gone", why: d.why };
  return null;
}

/**
 * The frames the panel looks in for this origin's signer: the client's own
 * frames (a world), and each of theirs (the signer a world embeds). Two
 * levels and no deeper, and never the panel itself.
 */
export function framesOfClient(panel: Window): Window[] {
  const out: Window[] = [];
  try {
    const client = panel.parent;
    for (let i = 0; i < client.frames.length; i++) {
      const world = client.frames[i]!;
      if (world === panel) continue;
      out.push(world);
      for (let j = 0; j < world.frames.length; j++) out.push(world.frames[j]!);
    }
  } catch {
    /* the client went away: nothing is found */
  }
  return out;
}
