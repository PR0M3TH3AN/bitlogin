// Way 1 of signing in a headset from your phone (docs/pair-a-headset.md): BitLogin's own page, top-level in the
// headset's 2D browser, opened by a world from a press. The code, its QR and the number the phone asks are shown here
// only, never in the world, which can't draw over this page's address bar. It finds the world's signer through its
// opener, as the sign-in window does: the site is that signer's (the browser's word), and the phone seals the hand-off
// to that signer's one-time key. This page passes it on, sealed: it never holds the key.
import { deviceLabel, findEmbeddedSigner, pairUrl, renderQrSvg, VR_CHOICES } from "../vendor/bitlogin/bitlogin-window.js";
import { createHeadlessSigner } from "../vendor/bitlogin/bitlogin-headless.js";

const $ = (id) => document.getElementById(id);
const say = (text) => {
  $("said").textContent = text;
  $("said").hidden = !text;
};
/** Relays other than BitLogin's own list, where the page names them. The live page names none. */
const relayList = (value) => (value || "").split(",").map((url) => url.trim()).filter(Boolean);
const relays = {
  vaultRelays: relayList(document.documentElement.dataset.vaultRelays),
  discoveryRelays: relayList(document.documentElement.dataset.discoveryRelays)
};

// The first line is the trust: said again whenever this page is looked at again, as a world may have moved it.
const recheck = () => {
  $("check").classList.remove("headset-check-again");
  void $("check").offsetWidth;
  $("check").classList.add("headset-check-again");
};
window.addEventListener("focus", recheck);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && recheck());

let worker = null;
let found = null;
let polling = null;
const stop = () => {
  if (polling) clearTimeout(polling);
  polling = null;
  void worker?.headsetCancel().catch(() => {});
};
window.addEventListener("pagehide", stop);

const begin = async () => {
  $("again").hidden = true;
  $("step-code").hidden = true;
  say("Finding the world you came from.");
  found ??= await findEmbeddedSigner().catch(() => null);
  if (!found) return say("This page finds the world that opened it. Open it from the world's \"Sign In using Phone\".");
  $("site").textContent = found.site;
  $("site-line").hidden = false;
  try {
    worker ??= await createHeadlessSigner(relays);
    const offer = await worker.headsetBegin(found.site, deviceLabel(navigator.userAgent), found.recipient);
    const url = pairUrl(location.origin, offer.code);
    const svg = new DOMParser().parseFromString(renderQrSvg(url, "A QR code for your phone"), "image/svg+xml").documentElement;
    $("qr").replaceChildren(document.importNode(svg, true));
    $("code").textContent = offer.code;
    $("number-line").hidden = true;
    const minutes = Math.max(1, Math.round((offer.expires - Date.now() / 1000) / 60));
    $("lasts").textContent = `The code lasts ${minutes} minutes and works once.`;
    // VR way: the same two lines the phone asks about, read here while the code is up.
    if (document.documentElement.dataset.vrWay === "on") {
      $("vr-inside-line").textContent = `${VR_CHOICES.inside.label}: ${VR_CHOICES.inside.line}`;
      $("vr-out-line").textContent = `${VR_CHOICES.out.label}: ${VR_CHOICES.out.line}`;
      $("vr-lines").hidden = false;
    }
    $("step-code").hidden = false;
    say("");
    look();
  } catch {
    say("That didn't work. Check this headset is online, then show a new code.");
    $("again").hidden = false;
  }
};

const look = async () => {
  let now;
  try {
    now = await worker.headsetPoll();
  } catch {
    now = { status: "ended" };
  }
  if (now.status === "found" && now.number !== undefined) {
    $("number").textContent = String(now.number);
    $("number-line").hidden = false;
  }
  if (now.status === "paired" && now.sealed) {
    $("step-code").hidden = true;
    say("Signing in.");
    // To the world's own signer, by the hand-off, as Allow passes one. It checks the site and keeps the grant.
    const ok = await found.passOn(now.sealed).catch(() => false);
    if (!ok) {
      say("The world didn't take it. Close this page, and sign in again from the world.");
      return;
    }
    say("Signed in. Go back to the world.");
    setTimeout(() => window.close(), 2000);
    return;
  }
  if (now.status === "ended" || now.status === "expired" || now.status === "paired") {
    $("step-code").hidden = true;
    say(now.status === "expired" ? "The code ran out. Nothing was signed in." : "The phone said no, so nothing was signed in.");
    $("again").hidden = false;
    return;
  }
  polling = setTimeout(look, 700);
};

$("again-button").addEventListener("click", () => {
  stop();
  void begin();
});
void begin();
