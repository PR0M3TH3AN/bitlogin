// The sign-in address's list of the sites it allowed from this browser (docs/sign-in-window.md §SW18). A record,
// read from this origin's own storage. Everything a site supplied is written as text, never as markup.
import { describeAllowed, describePermissions, inFamily, loadAllowed, saveAllowed } from "../vendor/bitlogin/bitlogin-window.js";
import { readCachedSession } from "../vendor/bitlogin/bitlogin-session.js";
import { createHeadlessSigner } from "../vendor/bitlogin/bitlogin-headless.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const day = (seconds) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const shortKey = (hex) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;

const me = await readCachedSession().catch(() => null);

/**
 * Who is signed in here: the name and picture from their own signed profile, and the whole key, so one account is
 * not mistaken for another. The key and the name this address knows are shown at once; the profile when relays
 * answer. Written as text; a picture that does not load gives way to a letter.
 */
const showMe = (profile) => {
  if (!me) return;
  const name = profile?.name || me.name || "";
  $("me").hidden = false;
  $("me-name").textContent = name || "An account with no name";
  $("me-key").textContent = me.npub;
  const pic = $("me-pic");
  const letter = () => pic.replaceChildren(document.createTextNode((name || "?").trim().slice(0, 1).toUpperCase()));
  letter();
  if (profile?.picture) {
    const img = new Image();
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onload = () => pic.replaceChildren(img);
    img.onerror = letter;
    img.src = profile.picture;
  }
};
showMe(null);

const say = (text) => {
  $("said").textContent = text;
  $("said").hidden = !text;
};
/** Relays other than BitLogin's own list, where the page names them. The live page names none. */
const relayList = (value) => (value || "").split(",").map((url) => url.trim()).filter(Boolean);

/**
 * Publish the record that takes a site back, or every site (docs/take-back.md). It is signed in BitLogin's
 * worker, by the account signed in here. Resolves true only when enough relays accepted it to be found.
 */
const publish = async (what, pubkey) => {
  let session = null;
  try {
    session = await createHeadlessSigner({
      vaultRelays: relayList(document.documentElement.dataset.vaultRelays),
      discoveryRelays: relayList(document.documentElement.dataset.discoveryRelays)
    });
    const restored = await session.restore();
    if (!restored) {
      say("Sign in on your account page first, and unlock BitLogin if you have a lock on. Nothing was taken back.");
      return false;
    }
    if (pubkey && restored.pubkey !== pubkey) {
      say("That site was allowed as another account. Sign in as that account to take it back. Nothing was taken back.");
      return false;
    }
    const result = await session.takeBack(what);
    if (!result.ok) {
      say(`Only ${result.accepted} of ${result.of} relays accepted it, which is not enough to rely on. Nothing was taken back. Try again, or open the site and sign out there.`);
      return false;
    }
    return true;
  } catch {
    say("That didn't work, and nothing was taken back. Open the site and sign out there.");
    return false;
  } finally {
    session?.destroy();
  }
};

const draw = () => {
  const now = Date.now() / 1000;
  const list = loadAllowed(now);
  $("empty").hidden = list.length > 0;
  $("sites").replaceChildren(
    ...list.map((entry) => {
      const words = describeAllowed(entry, now);
      const item = el("li", "", words.ended ? "sites-ended" : "");
      item.dataset.site = entry.site;
      if (words.family) {
        // A family (docs/site-family.md): every site under one domain, allowed at once.
        item.append(el("p", `Every site at ${words.family}`, "connect-site"));
        if (entry.members?.length) item.append(el("p", `Allowed from ${entry.members.join(", ")}. Others of its sites that signed you in since are not listed here.`, "connect-small"));
        if (words.known) item.append(el("p", `BitLogin knows this family: it is ${words.known}.`, "connect-small"));
      } else {
        item.append(el("p", entry.site, "connect-site"));
        if (words.known) item.append(el("p", `BitLogin knows this address: it is ${words.known}.`, "connect-small"));
      }
      if (entry.device) {
        // A headset signed in from this phone (docs/pair-a-headset.md): its own grant, signed out on its own.
        item.append(el("p", `A headset${entry.deviceLabel ? ` (${entry.deviceLabel})` : ""}, signed in from this phone on ${new Date(entry.at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "long" })}.`));
      }
      item.append(el("p", `As ${me && me.pubkey === entry.pubkey ? me.name || "the account signed in here" : `another account (${shortKey(entry.pubkey)})`}.`));
      if (entry.refused) {
        item.append(el("p", "It had been allowed more than any site may now have, so BitLogin ended it."));
        if (entry.hadNames?.length) item.append(el("p", `Data names it had been allowed: ${entry.hadNames.join(", ")}.`, "connect-small"));
      } else if (entry.wants) {
        const can = describePermissions(entry.wants, entry.site);
        const what = el("ul");
        for (const line of [...can.ordinary, ...can.sensitive]) what.append(el("li", line));
        item.append(el("p", "It may:"), what);
      } else {
        item.append(el("p", "It may post notes and reactions as you, and tell the others there who you are."));
      }
      item.append(el("p", `Allowed ${day(entry.at)}. ${words.ended ? "" : `Ends ${day(entry.until)} at the latest. `}${words.lasts}`, "connect-small"));
      const row = el("div", "", "cta-row");
      if (entry.device && !words.ended) {
        item.append(el("p", "If you think someone has read this headset's storage, sign it out, then make a new account: BitLogin can't change an account's key yet.", "connect-small"));
      }
      if (!words.ended && !words.family && !entry.device) {
        const open = el("a", "Open it to sign out", "btn secondary");
        // The address was read as an http(s) origin before it was ever kept. No link back to this page is given.
        open.href = entry.site;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        row.append(open);
      }
      const remove = el("button", words.ended ? "Remove from this list" : entry.device ? "Sign out this headset" : "Take it back", "btn secondary");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!words.ended) {
          remove.disabled = true;
          say(entry.device ? "Signing the headset out." : "Taking it back.");
          if (!(await publish(entry.device ? { device: entry.device } : { site: entry.site }, entry.pubkey))) {
            remove.disabled = false;
            return;
          }
          say(
            entry.device
              ? "Signed out: that headset, and no other device. It stops when its signer next checks, usually within a day, and at once if it is signed out in the world itself."
              : words.family
              ? `Taken back: every site at ${words.family}. Each stops when its signer next checks, usually within a day. To stop one this minute, open it and sign out there.`
              : `Taken back: ${entry.site}. It stops when its signer next checks, usually within a day. To stop it this minute, open it and sign out there.`
          );
        }
        // What the record now ends goes from the list with it: a family takes its sites' own grants with it, and a
        // site of a family takes the family's grant (docs/site-family.md SF6).
        // A headset's sign-out ends that headset alone.
        const ended = (other) =>
          entry.device ? other.device === entry.device :
          other.pubkey === entry.pubkey && (other.site === entry.site || (!words.ended && (inFamily(other.site, entry.site) || inFamily(entry.site, other.site))));
        saveAllowed(loadAllowed(Date.now() / 1000).filter((other) => !ended(other)));
        draw();
      });
      row.append(remove);
      item.append(row);
      return item;
    })
  );
};
draw();

$("all").addEventListener("click", async () => {
  $("all").disabled = true;
  say("Signing out of every site.");
  if (await publish({ all: true })) {
    // Everything on the list was allowed before now, so all of it is taken back.
    saveAllowed([]);
    draw();
    say("Every site is taken back, on every device. Each stops when its signer next checks, usually within a day.");
  }
  $("all").disabled = false;
});

// Their profile, behind everything else: read by BitLogin's worker and believed only as far as its signature goes.
if (me) {
  let session = null;
  try {
    session = await createHeadlessSigner({
      vaultRelays: relayList(document.documentElement.dataset.vaultRelays),
      discoveryRelays: relayList(document.documentElement.dataset.discoveryRelays)
    });
    const restored = await session.restore();
    if (restored && restored.pubkey === me.pubkey) showMe(await session.loadProfile());
  } catch {
    /* no relay answered, or the lock is on: the key and the name stay as they are */
  } finally {
    session?.destroy();
  }
}
