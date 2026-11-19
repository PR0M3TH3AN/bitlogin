// BitLogin's sign-in window (docs/sign-in-window.md §SW3). A site that wants something signed opens this page in a
// window of its own. It finds BitLogin's own embedded signer inside the page that opened it, shows which site that
// is (the browser's word for it), and waits for Allow. Then the session's key moves to the signer, sealed inside
// BitLogin's workers, as a key that can only sign.
//
// This page never holds the key, and speaks only to pages of its own origin.
import { askLockDevice, describePermissions, findEmbeddedSigner, knownAppName, recordAllowed, SIGN_LIMITS } from "../vendor/bitlogin/bitlogin-window.js";
import { createHeadlessSigner } from "../vendor/bitlogin/bitlogin-headless.js";
import { readCachedSession } from "../vendor/bitlogin/bitlogin-session.js";

const $ = (id) => document.getElementById(id);
const status = (text) => {
  $("status").textContent = text;
};
const shortKey = (npub) => `${npub.slice(0, 10)}…${npub.slice(-4)}`;
/** A press sooner than a person could have read the question was meant for the site, and is ignored. */
const TOO_SOON_MS = 900;

let found = null;
let who = null;
/** Whether the optional lock is on in this browser. Then nothing is kept for any site (§SW12). */
let lockOn = false;
let askedAt = 0;
let finished = false;

/** Relays other than BitLogin's own list, where the page names them. The live page names none. */
const relayList = (value) => (value || "").split(",").map((url) => url.trim()).filter(Boolean);
const relays = {
  vaultRelays: relayList(document.documentElement.dataset.vaultRelays),
  discoveryRelays: relayList(document.documentElement.dataset.discoveryRelays)
};

/**
 * The session whose key will be handed over, made ready while the question is being read: and, for a site that
 * declared nothing, the person's own signed profile, which BitLogin's worker fetches, checks and seals into the
 * hand-off (§SW16). This page never sees the key, and is not asked for the profile.
 */
let preparing = null;
let profileLoaded = Promise.resolve();
/** The one worker this page talks to. Where the lock is on, it is the one that was unlocked. */
let worker = null;
const theWorker = async () => (worker ??= await createHeadlessSigner(relays));
const prepare = () =>
  (preparing ??= (async () => {
    const session = await theWorker();
    const restored = await session.restore();
    if (!restored || restored.pubkey !== who.pubkey) throw new Error("no session");
    // Only a world is told who someone is. An application is held to what it asked, and this is not in it.
    if (!found.wants) profileLoaded = session.loadProfile().catch(() => null);
    return session;
  })());
/** How long Allow waits for relays to answer about the profile. Without one, the site is told the key alone. */
const PROFILE_WAIT_MS = 2500;

const leave = () => {
  finished = true;
  window.close();
  // A window the browser won't close for us says what to do.
  $("ask").hidden = true;
  $("ask-app").hidden = true;
  $("signin").hidden = true;
  status("You can close this window.");
};

/**
 * How long it lasts (§SW11). Remembered unless they untick it: thirty days for a site BitLogin knows, seven for
 * any other. Unticked, it is for this visit. With the lock on, every site is for one visit, and there is no box.
 */
const days = () => (found.known ? 30 : 7);
const lasting = (what, row, box, label, line) => {
  const say = () => {
    $(line).textContent = lockOn
      ? `It lasts for this visit: until that ${what}'s page is closed or loaded again. Your lock is on, so nothing is kept for any site.`
      : $(box).checked
        ? `It lasts until you sign out of that ${what}, or ${days()} days, on this device.`
        : `It lasts for this visit: until that ${what}'s page is closed or loaded again. Then you are asked again.`;
  };
  $(row).hidden = lockOn;
  $(label).textContent = `Remember this ${what} on this device for ${days()} days`;
  $(box).checked = !lockOn;
  $(box).onchange = say;
  say();
};

/** A list, written as text: nothing a site sent is ever put on this page as markup. */
const fill = (id, lines) => {
  const list = $(id);
  list.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    })
  );
};

/** An application asked for more than a note and a reaction (§SW9): show all of it, in words, before Allow. */
const askApp = () => {
  const words = describePermissions(found.wants, found.site);
  $("app-site").textContent = found.site;
  // What BitLogin knows comes from the address, never from what the application says of itself.
  const known = knownAppName(found.site);
  $("app-known-name").textContent = known || "";
  $("app-known").hidden = !known;
  $("app-unknown").hidden = !!known;
  $("app-name").textContent = found.wants.name || "";
  // Its own name is shown only where BitLogin has none for it: beside a known name it would only confuse.
  $("app-name-line").hidden = !found.wants.name || !!known;
  $("app-who").textContent = who.name || shortKey(who.npub);
  $("app-who-key").textContent = who.name ? ` (${shortKey(who.npub)})` : "";
  lasting("application", "remember-app-row", "remember-app", "remember-app-label", "app-lasts");
  fill("app-ordinary", words.ordinary);
  fill("app-sensitive", words.sensitive);
  $("app-sensitive-block").hidden = words.sensitive.length === 0;
  status("An application is asking to act as you. Check the address, and read what it asks.");
  $("ask-app").hidden = false;
  askedAt = performance.now();
};

const ask = () => {
  if (!found || !who || finished) return;
  $("signin").hidden = true;
  void prepare().catch(() => {});
  if (found.wants) return askApp();
  $("site").textContent = found.site;
  $("who").textContent = who.name || shortKey(who.npub);
  $("who-key").textContent = who.name ? ` (${shortKey(who.npub)})` : "";
  lasting("site", "remember-row", "remember", "remember-label", "lasts");
  status("A site is asking to sign notes as you. Check the address.");
  $("ask").hidden = false;
  // Allow is never given the keys unasked: a key meant for the site, pressed as this window came up, must not land on it.
  askedAt = performance.now();
};

/**
 * The optional lock is on, and locked (§SW12): nothing can be handed over until it is opened, with this device's
 * own unlock where that was set up, or the PIN. A wrong try is counted; one too many signs this browser out.
 */
const unlock = (lock) => {
  status("A site is asking to sign notes as you. This browser is locked.");
  $("unlock").hidden = false;
  const done = async (result) => {
    if (result.ok) {
      $("unlock").hidden = true;
      return ask();
    }
    if (result.removed) {
      $("unlock").hidden = true;
      who = null;
      signIn();
      return status("Too many wrong tries. The lock and what this browser kept were removed. Sign in again the ordinary way.");
    }
    $("unlock-go").disabled = false;
    $("unlock-pin").value = "";
    status(`That didn't open it. ${result.left} ${result.left === 1 ? "try" : "tries"} left before this browser is signed out.`);
  };
  $("unlock-device").hidden = !lock.credentialId;
  $("unlock-device").onclick = async () => {
    const prfOutput = await askLockDevice(lock.credentialId);
    // Cancelled, or a device that can't: not a wrong try.
    if (!prfOutput) return status("The device didn't unlock it. Use your PIN.");
    await done(await (await theWorker()).lockOpen({ prfOutput }));
  };
  $("unlock-form").onsubmit = async (e) => {
    e.preventDefault();
    $("unlock-go").disabled = true;
    status("Unlocking.");
    await done(await (await theWorker()).lockOpen({ pin: $("unlock-pin").value }));
  };
};

const signIn = () => {
  status("A site is asking to sign notes as you.");
  $("signin").hidden = false;
  // The ordinary widget, on BitLogin's own page: the one place a password is typed.
  const widget = document.createElement("bitlogin-auth");
  widget.addEventListener("bitlogin-login", async () => {
    who = await readCachedSession();
    if (!who) return;
    widget.remove();
    ask();
  });
  $("widget-slot").append(widget);
};

const allow = async (button) => {
  if (!found || !who || performance.now() - askedAt < TOO_SOON_MS) return;
  button.disabled = true;
  status(found.wants ? "Handing over a key that can do only what you just read." : "Handing over a key that can only sign.");
  let session = null;
  try {
    session = await prepare();
    await Promise.race([profileLoaded, new Promise((done) => setTimeout(done, PROFILE_WAIT_MS))]);
    const remember = !lockOn && $(found.wants ? "remember-app" : "remember").checked;
    const ok = await found.grant(session, who.name, remember);
    $("ask").hidden = true;
    $("ask-app").hidden = true;
    if (!ok) return status("That didn't work, and nothing was handed over. Close this window and try again from the site that opened it.");
    // Written down at the sign-in address, for the list of sites allowed. A record only: it lets nothing sign.
    const at = Math.floor(Date.now() / 1000);
    recordAllowed({ site: found.site, pubkey: who.pubkey, at, until: at + (remember ? (found.known ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec) : SIGN_LIMITS.visitSec), remembered: remember, ...(found.wants ? { wants: found.wants } : {}) });
    const how = remember ? "until you sign out of it" : "for this visit";
    status(found.wants ? `Done. That application can act as you, as you allowed, ${how}.` : `Done. That site can sign notes as you ${how}.`);
    setTimeout(leave, 700);
  } catch {
    $("ask").hidden = true;
    $("ask-app").hidden = true;
    status("That didn't work, and nothing was handed over. If you signed in with a browser extension or a phone, this isn't offered for it yet.");
  } finally {
    session?.destroy();
  }
};
$("allow").addEventListener("click", () => allow($("allow")));
$("allow-app").addEventListener("click", () => allow($("allow-app")));
$("deny-app").addEventListener("click", leave);
$("deny").addEventListener("click", leave);
$("deny-2").addEventListener("click", leave);

if (!window.opener) {
  status("This window is opened by a site, when you ask it to sign in with BitLogin. There is nothing to do here on its own.");
} else {
  found = await findEmbeddedSigner();
  if (!found) {
    status("No BitLogin signer was found in the page that opened this window, so there is nothing to allow. The site may not support this, or your browser kept the two apart.");
  } else {
    who = await readCachedSession();
    const lock = who ? await (await theWorker()).lockStatus().catch(() => null) : null;
    lockOn = lock?.on === true;
    if (!who) signIn();
    else if (lock?.locked) unlock(lock);
    else ask();
  }
}
