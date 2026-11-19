// The sign-in address's list of the sites it allowed from this browser (docs/sign-in-window.md §SW18). A record,
// read from this origin's own storage. Everything a site supplied is written as text, never as markup.
import { describeAllowed, describePermissions, loadAllowed, removeAllowed, saveAllowed } from "../vendor/bitlogin/bitlogin-window.js";
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
      item.append(el("p", entry.site, "connect-site"));
      if (words.known) item.append(el("p", `BitLogin knows this address: it is ${words.known}.`, "connect-small"));
      item.append(el("p", `As ${me && me.pubkey === entry.pubkey ? me.name || "the account signed in here" : `another account (${shortKey(entry.pubkey)})`}.`));
      if (entry.wants) {
        const can = describePermissions(entry.wants, entry.site);
        const what = el("ul");
        for (const line of [...can.ordinary, ...can.sensitive]) what.append(el("li", line));
        item.append(el("p", "It may:"), what);
      } else {
        item.append(el("p", "It may post notes and reactions as you, and tell the others there who you are."));
      }
      item.append(el("p", `Allowed ${day(entry.at)}. ${words.ended ? "" : `Ends ${day(entry.until)} at the latest. `}${words.lasts}`, "connect-small"));
      const row = el("div", "", "cta-row");
      if (!words.ended) {
        const open = el("a", "Open it to sign out", "btn secondary");
        // The address was read as an http(s) origin before it was ever kept. No link back to this page is given.
        open.href = entry.site;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        row.append(open);
      }
      const remove = el("button", words.ended ? "Remove from this list" : "Take it back", "btn secondary");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!words.ended) {
          remove.disabled = true;
          say("Taking it back.");
          if (!(await publish({ site: entry.site }, entry.pubkey))) {
            remove.disabled = false;
            return;
          }
          say(`Taken back: ${entry.site}. It stops when its signer next checks, usually within a day. To stop it this minute, open it and sign out there.`);
        }
        saveAllowed(removeAllowed(loadAllowed(Date.now() / 1000), entry.site, entry.pubkey));
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
