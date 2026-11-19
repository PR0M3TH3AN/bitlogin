// BitLogin's sign-in window (docs/sign-in-window.md §SW3). A site that wants something signed opens this page in a
// window of its own. It finds BitLogin's own embedded signer inside the page that opened it, shows which site that
// is (the browser's word for it), and waits for Allow. Then the session's key moves to the signer, sealed inside
// BitLogin's workers, as a key that can only sign.
//
// This page never holds the key, and speaks only to pages of its own origin.
import { describePermissions, findEmbeddedSigner, knownAppName } from "../vendor/bitlogin/bitlogin-window.js";
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
let askedAt = 0;
let finished = false;

const leave = () => {
  finished = true;
  window.close();
  // A window the browser won't close for us says what to do.
  $("ask").hidden = true;
  $("ask-app").hidden = true;
  $("signin").hidden = true;
  status("You can close this window.");
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
  if (found.wants) return askApp();
  $("site").textContent = found.site;
  $("who").textContent = who.name || shortKey(who.npub);
  $("who-key").textContent = who.name ? ` (${shortKey(who.npub)})` : "";
  status("A site is asking to sign notes as you. Check the address.");
  $("ask").hidden = false;
  // Allow is never given the keys unasked: a key meant for the site, pressed as this window came up, must not land on it.
  askedAt = performance.now();
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
    session = await createHeadlessSigner();
    const restored = await session.restore();
    if (!restored || restored.pubkey !== who.pubkey) throw new Error("no session");
    const ok = await found.grant(session, who.name);
    $("ask").hidden = true;
    $("ask-app").hidden = true;
    if (!ok) return status("That didn't work, and nothing was handed over. Close this window and try again from the site that opened it.");
    status(found.wants ? "Done. That application can act as you, as you allowed, until you sign out of it." : "Done. That site can sign notes as you until you sign out of it.");
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
    if (who) ask();
    else signIn();
  }
}
