// Signing in a headset from this phone (docs/pair-a-headset.md). The headset shows a code (and a QR of this page with
// the code in its fragment, which reaches no server). This page finds the headset's offer by the code, sends it a
// number to show, and asks the person to tap the same: only then is "Sign in this headset?" put, and the yes sends
// the headset what Allow sends a site, sealed to the headset's one-time key, by BitLogin's worker. This page never
// holds a key. Everything an offer says is written as text, never as markup.
import { familyDomain, familyOf, knownAppName, knownFamily, normalizeCode, numberChoices, recordAllowed, SIGN_LIMITS } from "../vendor/bitlogin/bitlogin-window.js";
import { createHeadlessSigner } from "../vendor/bitlogin/bitlogin-headless.js";
import { readCachedSession } from "../vendor/bitlogin/bitlogin-session.js";

const $ = (id) => document.getElementById(id);
const STEPS = ["step-out", "step-holding", "step-code", "step-number", "step-ask"];
/** The press guard, as on Allow: a button shown less than this long ago does nothing (a tap meant for what was there). */
const GUARD_MS = 900;
let shownAt = 0;
const show = (step) => {
  for (const id of STEPS) $(id).hidden = id !== step;
  shownAt = Date.now();
};
const shownLongEnough = () => Date.now() - shownAt >= GUARD_MS;
const say = (text) => {
  $("said").textContent = text;
  $("said").hidden = !text;
};
/** It is over, for good or not: only "Start again" is left. */
const end = (text) => {
  show(null);
  say(text);
  $("again").hidden = false;
};

/** Relays other than BitLogin's own list, where the page names them. The live page names none. */
const relayList = (value) => (value || "").split(",").map((url) => url.trim()).filter(Boolean);
const relays = {
  vaultRelays: relayList(document.documentElement.dataset.vaultRelays),
  discoveryRelays: relayList(document.documentElement.dataset.discoveryRelays),
  // Way 2's switch, for tests: the worker takes it only where BitLogin runs at a local address.
  ...(document.documentElement.dataset.deviceKeys === "on" ? { deviceKeys: true } : {})
};

// The code from the address, and then out of it: it is not left in the history, or shown to a screen reader again.
const fromLink = normalizeCode(decodeURIComponent(location.hash.slice(1)));
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

let worker = null;
let offer = null;
let number = 0;
let shownCode = "";
let lockOn = false;

/** The code to look for, once the person says it is on BitLogin's own page on a headset they hold. */
let asked = fromLink;
const me = await readCachedSession().catch(() => null);
// Asked for every code, typed or scanned (Way 1): the danger is the world in front of them, so typing is no check.
if (!me) show("step-out");
else if (fromLink) show("step-holding");
else {
  show("step-code");
  $("code").focus();
}

$("holding-yes").addEventListener("click", () => {
  if (!shownLongEnough()) return;
  void find(asked);
});
$("holding-no").addEventListener("click", () => {
  if (!shownLongEnough()) return;
  end("Then don't sign it in. Someone may be trying to get into your account.");
});
$("step-code").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode($("code").value);
  if (!code) return say("A code is eight letters and digits, like K7QF-3MPX.");
  asked = code;
  say("");
  show("step-holding");
});

const find = async (code) => {
  show(null);
  say("Looking for the headset.");
  try {
    worker ??= await createHeadlessSigner(relays);
    const lock = await worker.lockStatus().catch(() => null);
    lockOn = lock?.on === true;
    shownCode = code;
    const restored = lock?.locked ? null : await worker.restore().catch(() => null);
    if (!restored || restored.pubkey !== me.pubkey) {
      return end(lock?.locked ? "BitLogin is locked on this phone. Open your account page, unlock it, then come back to this page." : "Sign in to BitLogin on this phone first, then come back to this page.");
    }
    const offers = await worker.pairFind(code);
    if (offers.length === 0) return end("No headset is showing that code. Check it, or ask for a new one.");
    if (offers.length > 1) return end("Two devices are showing that code. Start again on the headset.");
    offer = offers[0];
    // Only a code from BitLogin's own headset page, which names the world's signer: one a world drew is never answered.
    if (!offer.to) return end("That code wasn't made by BitLogin's own page, so it can't be used. In the world, press Sign In using Phone, and use the code on the bitlogin.network page it opens.");
    number = await worker.pairFound(offer.id);
    say("");
    $("numbers").replaceChildren(
      ...numberChoices(number).map((n) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn secondary pair-number";
        button.textContent = String(n);
        button.addEventListener("click", () => {
          if (shownLongEnough()) void tapped(n);
        });
        return button;
      })
    );
    show("step-number");
  } catch {
    end("That didn't work, and nothing was signed in. Start again on the headset.");
  }
};

const tapped = async (n) => {
  if (n !== number) {
    // A wrong tap ends it on both sides: the headset drops its one-time key and says so.
    show(null);
    await worker.pairEnd(offer.id).catch(() => {});
    return end("That isn't the number the headset shows, so nothing was signed in. If you are holding the headset, start again there.");
  }
  ask();
};

/** Whether a family's every site may be offered: the site's own, and one BitLogin knows, as the window offers it. */
let family = "";
const ask = () => {
  family = familyOf(offer.site);
  // Not with the lock on: then it is for the headset's visit only, and a family is never kept for a visit.
  const offerFamily = !!family && knownFamily(family) && !lockOn;
  $("ask-device").textContent = offer.device === "a device" ? "A headset" : `A headset (${offer.device})`;
  $("ask-site").textContent = `at ${offer.site}`;
  $("ask-code").textContent = `Code ${shownCode}`;
  const known = knownAppName(offer.site);
  $("ask-lasts").textContent = [known ? `BitLogin knows this address: it is ${known}.` : "", lockOn ? "Your lock is on, so it stays signed in for this visit only." : ""].filter(Boolean).join(" ");
  $("ask-family").hidden = !offerFamily;
  if (offerFamily) $("ask-family").textContent = `Stay signed in at every ${familyDomain(family)} site`;
  $("ask-site-only").textContent = offerFamily ? "Just this site" : "Sign in";
  show("step-ask");
};

const answer = async (asFamily) => {
  if (!shownLongEnough()) return;
  show(null);
  say("Signing the headset in.");
  try {
    const { device, deviceKey } = await worker.pairAnswer(offer.id, number, asFamily ? family : undefined);
    const at = Math.floor(Date.now() / 1000);
    const remembered = !lockOn;
    const known = asFamily ? knownFamily(family) : knownAppName(offer.site) !== null;
    const until = at + (remembered ? (known ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec) : SIGN_LIMITS.visitSec);
    recordAllowed({ site: asFamily ? family : offer.site, ...(asFamily ? { members: [offer.site] } : {}), pubkey: me.pubkey, at, until, remembered, device, ...(deviceKey ? { deviceKey } : {}), ...(offer.device !== "a device" ? { deviceLabel: offer.device } : {}) });
    end(`Sent. The headset signs in at ${offer.site} in a moment. You can sign it out from Sites you allowed.`);
  } catch {
    end("That didn't work, and nothing was signed in. Start again on the headset.");
  }
};
$("ask-family").addEventListener("click", () => void answer(true));
$("ask-site-only").addEventListener("click", () => void answer(false));
$("ask-no").addEventListener("click", async () => {
  if (!shownLongEnough()) return;
  show(null);
  await worker.pairEnd(offer.id).catch(() => {});
  end("Nothing was signed in, and the headset was told.");
});
