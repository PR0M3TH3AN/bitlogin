// BitLogin's sign-in window (docs/sign-in-window.md §SW3). A site that wants something signed opens this page in a
// window of its own. It finds BitLogin's own embedded signer inside the page that opened it, shows which site that
// is (the browser's word for it), and waits for Allow. Then the session's key moves to the signer, sealed inside
// BitLogin's workers, as a key that can only sign.
//
// This page never holds the key, and speaks only to pages of its own origin.
//
// The same page is the sign-in panel (§SW19), served at /connect/panel/: shown in a frame by a client BitLogin lists
// (BitPortal's shell), where the world's menu is, so the visitor never leaves the world. Then it finds the signer in
// the client's frames, not the opener's, and tells the client when it is done instead of closing a window. The client
// is told nothing else: no key, no name, no account.
import {
  PANEL_CLIENTS,
  panelClientAllowed,
  panelMessage,
  readPanelHello,
  askLockDevice,
  declineFamily,
  describeAsked,
  describePermissions,
  familyDeclined,
  familyDomain,
  familyOffer,
  findEmbeddedSigner,
  knownAppName,
  loadAllowed,
  recordAllowed,
  SIGN_LIMITS
} from "../vendor/bitlogin/bitlogin-window.js";
import { createHeadlessSigner } from "../vendor/bitlogin/bitlogin-headless.js";
import { readCachedSession } from "../vendor/bitlogin/bitlogin-session.js";

const $ = (id) => document.getElementById(id);
/** Whether this is the panel, by its own address. /connect/ itself may never be framed. */
const inPanel = location.pathname.includes("/connect/panel/");
/** The client showing the panel: the browser's word for its origin, checked against BitLogin's list. */
let client = null;
/** How tall this page's content is: the bar, and what is under it. Not the frame's own height, which is the client's. */
const contentHeight = () => Math.ceil((document.querySelector(".nav")?.getBoundingClientRect().height ?? 0) + (document.querySelector("main")?.getBoundingClientRect().height ?? 0)) + 2;
let lastSize = "menu";
let lastHeight = 0;
const toClient = (message) => {
  if (!client) return;
  // A size goes with how tall the content is, so a short page is not shown with empty space under it.
  if (message.t === "size") {
    lastSize = message.size;
    lastHeight = contentHeight();
    message = { ...message, height: lastHeight };
  }
  window.parent.postMessage(panelMessage(message), client);
};
/** The content grew or shrank (a list arrived, a step changed): the client is told the new height. */
if (inPanel && typeof ResizeObserver === "function") {
  let waiting = false;
  new ResizeObserver(() => {
    if (waiting || !client) return;
    waiting = true;
    requestAnimationFrame(() => {
      waiting = false;
      if (Math.abs(contentHeight() - lastHeight) > 4) toClient({ t: "size", size: lastSize });
    });
  }).observe(document.querySelector("main"));
}
/** What a press that ends the question says to the person: a window they close, or a panel. */
const here = inPanel ? "panel" : "window";
const status = (text) => {
  $("status").textContent = text;
};
/** A press sooner than a person could have read the question was meant for the site, and is ignored. */
const TOO_SOON_MS = 900;

let found = null;
let who = null;
/** Whether the optional lock is on in this browser. Then nothing is kept for any site (§SW12). */
let lockOn = false;
let askedAt = 0;
let finished = false;
/** Where every site of this one's family may be allowed at once (docs/site-family.md SF4): the earlier site of it. */
let offer = null;

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
/** Their own signed profile, once relays have answered: shown so they can see which account this is. */
let profile = null;
/** The one worker this page talks to. Where the lock is on, it is the one that was unlocked. */
let worker = null;
const theWorker = async () => (worker ??= await createHeadlessSigner(relays));
const prepare = () =>
  (preparing ??= (async () => {
    const session = await theWorker();
    const restored = await session.restore();
    if (!restored || restored.pubkey !== who.pubkey) throw new Error("no session");
    // Their profile is read for every site, to show them which account this is. Only a world is told it: the
    // worker leaves it out of an application's hand-off. Their relay list is read too: it is where the signer
    // later looks for a take-back (docs/take-back.md).
    const forWho = who.pubkey;
    profileLoaded = session
      .loadProfile()
      .then((found_) => {
        if (who?.pubkey !== forWho) return;
        profile = found_;
        paintWho();
      })
      .catch(() => null);
    return session;
  })());
/**
 * Who they are signing in as: the name and picture from their own signed profile, the whole key, and the line
 * about them. Before relays answer, and where there is no profile, the name the sign-in address knows them by.
 * Everything is written as text. The picture is an https address the worker cleaned; where it does not load, the
 * first letter of the name stands in.
 */
const paintWho = () => {
  if (!who) return;
  const name = profile?.name || who.name || "";
  for (const pre of ["", "app-"]) {
    $(`${pre}who`).textContent = name || "An account with no name";
    $(`${pre}who-key`).textContent = who.npub;
    $(`${pre}who-about`).textContent = profile?.about || "";
    $(`${pre}who-about`).hidden = !profile?.about;
    const pic = $(`${pre}who-pic`);
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
  }
};

/** How long Allow waits for relays to answer about the profile. Without one, the site is told the key alone. */
const PROFILE_WAIT_MS = 2500;

const leave = (allowed = false) => {
  finished = true;
  if (inPanel) {
    $("ask").hidden = true;
    $("ask-app").hidden = true;
    $("signin").hidden = true;
    $("choose").hidden = true;
    toClient({ t: "close", allowed: allowed === true });
    return;
  }
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
const lasting = (what, row, box, label, line, after) => {
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
  $(box).onchange = () => {
    say();
    after?.();
  };
  say();
};

/**
 * The family question, at the second site of a family (docs/site-family.md SF4): two buttons in place of Allow,
 * neither of them the default. Only while "remember" is ticked: a family is never allowed for one visit.
 */
/** What a world may ask to be let do, as it is put on the button. */
const MORE_WORDS = { follows: "change who I follow", messages: "send and read my private messages" };
const familyShown = () => !!offer && !lockOn && $("remember").checked;
const showFamily = () => {
  const shown = familyShown();
  $("family").hidden = !shown;
  $("allow-family").hidden = !shown;
  // A world that asked to change who they follow: two buttons, neither the default, as for a family.
  // And so for private messages. What the site already had is kept either way; the question is about what is new.
  const asked = found ? found.more : [];
  $("more-follows").hidden = !asked.includes("follows");
  $("more-messages").hidden = !asked.includes("messages");
  $("allow-more").hidden = asked.length === 0;
  // The plain grant's "it can't" is not said flatly beside a question that would let it, or beside what it has.
  const had = found ? found.has : [];
  const yours = (name) => MORE_WORDS[name].replace(/\bI\b/gu, "you").replace(/\bmy\b/gu, "your");
  $("has-line").hidden = had.length === 0;
  $("has-line").textContent = had.length ? `You already let it ${had.map(yours).join(" and ")}. That stays as it is whichever you choose.` : "";
  $("cant").textContent =
    had.length || asked.length
      ? "Apart from what is said above, it can't read your messages, change your profile or who you follow, or touch your account or anything in it."
      : "It can't read your messages, change your profile or who you follow, or touch your account or anything in it.";
  $("allow-more").textContent = `Allow, and let it ${asked.map((name) => MORE_WORDS[name]).join(" and ")}`;
  $("allow").textContent = shown ? "Just this one" : asked.length ? "Allow without that" : "Allow";
  if (!offer) return;
  const domain = familyDomain(found.family);
  $("family-earlier").textContent = offer.site;
  $("family-when").textContent = `on ${new Date(offer.at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
  $("family-domain").textContent = domain;
  $("family-lasts").textContent = `It lasts ${found.knownFamily ? 30 : 7} days on this device, or until you sign out of any one of them, which signs you out of them all.`;
  $("allow-family").textContent = `Allow every ${domain} site`;
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
  $("app-local").hidden = !found.local;
  paintWho();
  lasting("application", "remember-app-row", "remember-app", "remember-app-label", "app-lasts");
  fill("app-ordinary", words.ordinary);
  fill("app-sensitive", words.sensitive);
  $("app-sensitive-block").hidden = words.sensitive.length === 0;
  status("An application is asking to act as you. Check the address, and read what it asks.");
  $("ask-app").hidden = false;
  askedAt = performance.now();
};

/**
 * The site put something to the person (§SW20): a careful kind, or the use of a wallet. It is answered as the
 * account the site is signed in as, and no other.
 */
const sameAccount = () => {
  if (who.pubkey === found.askedAs) return true;
  status("That site is signed in as a different account from the one signed in here. Sign out of it there, or sign in here as that account, and ask again.");
  void found.answer(null);
  toClient({ t: "size", size: "menu" });
  return false;
};
const answered = async (result, done) => {
  $("confirm").hidden = true;
  $("wallet").hidden = true;
  $("files").hidden = true;
  const ok = await found.answer(result).catch(() => false);
  status(result === null ? "Nothing was signed or shared." : ok ? done : "That didn't work, and nothing reached the site. Ask again from the site.");
  setTimeout(() => leave(ok && result !== null), result === null ? 0 : 700);
};
const askSign = async () => {
  if (!sameAccount()) return;
  const event = found.ask.event;
  // A profile is replaced whole, so what is shown is what would change, against the one relays hold now. Where
  // that can't be read in a few seconds, the whole new one is shown, and a line says so.
  let current;
  if (event.kind === 0) {
    status("Reading your profile as it is now.");
    const read = await Promise.race([prepare().then((session) => session.profileContent()), new Promise((done) => setTimeout(() => done(null), 5000))]).catch(() => null);
    current = read?.answered ? (read.content ?? "{}") : null;
    if (finished) return;
  }
  const words = describeAsked(event, current);
  $("confirm-title").textContent = words.title;
  $("confirm-site").textContent = found.site;
  $("confirm-who").textContent = who.name || "An account with no name";
  $("confirm-who-key").textContent = who.npub;
  $("confirm-warning").textContent = words.warning;
  fill("confirm-lines", words.lines);
  status("A site is asking you to sign something that deserves a look. Read it first.");
  toClient({ t: "size", size: "menu" });
  $("confirm").hidden = false;
  askedAt = performance.now();
  $("confirm-no").onclick = () => void answered(null);
  $("confirm-yes").onclick = async () => {
    if (performance.now() - askedAt < TOO_SOON_MS) return;
    $("confirm-yes").disabled = true;
    let session = null;
    try {
      session = await prepare();
      // Signed here, by BitLogin's own session, exactly as it was shown. The site's signer checks it is.
      const signed = await session.signEvent({ kind: event.kind, content: event.content, tags: event.tags, created_at: Math.floor(Date.now() / 1000) });
      await answered({ event: signed }, "Done. It was signed, and handed to the site.");
    } catch {
      await answered(null);
    } finally {
      session?.destroy();
    }
  };
};
/**
 * A site asked to be paid (docs/ecash.md): the person's own ecash wallet pays the invoice, if they press Pay. The
 * site hears that it was paid, and nothing about the wallet: not what it holds, not which mint, not a token.
 */
const askPay = async () => {
  if (!sameAccount()) return;
  status("A site is asking to be paid from your ecash wallet.");
  const { openEcash } = await import("./ecash-ui.js");
  // The wallet is the signed-in account's: its session is taken up first.
  const session = await prepare().catch(() => null);
  if (!session) return void answered(null);
  await openEcash({
    worker: session,
    resize: (size) => toClient({ t: "size", size }),
    request: { site: found.site, invoice: found.ask.invoice },
    done: (paid) => void answered(paid ? { paid } : null, "Paid.")
  });
};
/**
 * A site offered a file to be saved, or asked for one (docs/files.md). The person's own file browser is shown. The
 * site learns the name a saved file was given, or is handed the one file they chose, and nothing else of what they keep.
 */
const askFile = async () => {
  if (!sameAccount()) return;
  const saving = found.ask.what === "save";
  status(saving ? "A site wants to save a file to your files." : "A site is asking you for a file.");
  const { openFiles } = await import("./files-ui.js");
  const session = await prepare().catch(() => null);
  if (!session) return void answered(null);
  await openFiles({
    worker: session,
    resize: (size) => toClient({ t: "size", size }),
    request: saving ? { site: found.site, save: { name: found.ask.name, type: found.ask.type, bytes: found.ask.bytes, private: found.ask.private } } : { site: found.site, pick: true },
    done: (result) => void answered(result ?? null, saving ? "Saved." : "Sent.")
  });
};
/** The file browser opened on its own, from the account page. */
const showFiles = async () => {
  $("account").hidden = true;
  status("");
  const { openFiles } = await import("./files-ui.js");
  await openFiles({ worker: await theWorker(), resize: (size) => toClient({ t: "size", size }), done: () => showAccount() });
};
/** The wallet opened on its own, from the account page. */
const showEcash = async () => {
  $("account").hidden = true;
  status("");
  const { openEcash } = await import("./ecash-ui.js");
  await openEcash({ worker: await theWorker(), resize: (size) => toClient({ t: "size", size }), done: () => showAccount() });
};

const askWallet = () => {
  if (!sameAccount()) return;
  $("wallet-site").textContent = found.site;
  status("A site is asking to use a wallet.");
  toClient({ t: "size", size: "tall" });
  $("wallet").hidden = false;
  $("wallet-no").onclick = () => void answered(null);
  // The widget's own wallet step: a connection already made for this site, or a new one, chosen with Bitcoin
  // Connect or pasted. It is saved for this site's address, the one shown above, and for no other.
  const widget = makeWidget();
  $("wallet-slot").replaceChildren(widget);
  customElements
    .whenDefined("bitlogin-auth")
    .then(() => widget.requestNwcConnection({ appName: new URL(found.site).host, forSite: found.site }))
    .then((uri) => answered(uri ? { wallet: uri } : null, "Done. That site can use the wallet you chose."))
    .catch(() => answered(null));
};

const ask = () => {
  if (!found || !who || finished) return;
  $("signin").hidden = true;
  if (found.ask) return found.ask.what === "wallet" ? askWallet() : found.ask.what === "pay" ? void askPay() : found.ask.what === "save" || found.ask.what === "pick" ? void askFile() : void askSign();
  toClient({ t: "size", size: "menu" });
  void prepare().catch(() => {});
  if (found.wants) return askApp();
  $("site").textContent = found.site;
  // It asked for more than it may have here: said plainly, so the smaller question is not mistaken for all of it.
  $("turned-down").hidden = !found.turnedDown;
  paintWho();
  // Offered only where an earlier site of the same family was allowed, as this account, and not turned down lately.
  offer = !lockOn && found.family && !familyDeclined(found.family) ? familyOffer(loadAllowed(), found.site, found.family, who.pubkey) : null;
  lasting("site", "remember-row", "remember", "remember-label", "lasts", showFamily);
  showFamily();
  status("A site is asking to sign notes as you. Check the address.");
  $("ask").hidden = false;
  // Allow is never given the keys unasked: a key meant for the site, pressed as this window came up, must not land on it.
  askedAt = performance.now();
};

/**
 * The optional lock is on, and locked (§SW12): nothing can be handed over until it is opened, with this device's
 * own unlock where that was set up, or the PIN. A wrong try is counted; one too many signs this browser out.
 */
const unlock = (lock, then) => {
  status("A site is asking to sign notes as you. This browser is locked.");
  $("unlock").hidden = false;
  const done = async (result) => {
    if (result.ok) {
      $("unlock").hidden = true;
      if (then) return then();
      // Open. Someone is signed in, or nobody is and one of the accounts kept here is to be chosen.
      who = await readCachedSession();
      return who ? ask() : choose();
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
  status(inPanel ? "A site is asking to sign notes as you. Sign in, and the question comes next." : "A site is asking to sign notes as you.");
  $("signin").hidden = false;
  toClient({ t: "size", size: "tall" });
  // The ordinary widget, on BitLogin's own page: the one place a password is typed.
  const widget = makeWidget();
  widget.addEventListener("bitlogin-login", async () => {
    who = await readCachedSession();
    if (!who) return;
    widget.remove();
    ask();
  });
  // One widget at a time: this can be reached more than once in a window's life.
  $("widget-slot").replaceChildren(widget);
};

/** The ordinary widget, with the relays this page was given, where it names any. */
const makeWidget = () => {
  const widget = document.createElement("bitlogin-auth");
  // In the panel the widget is dark, as the panel is, whatever the browser's theme.
  if (inPanel) widget.dataset.theme = "dark";
  if (relays.vaultRelays.length) widget.setAttribute("vault-relays", relays.vaultRelays.join(","));
  if (relays.discoveryRelays.length) widget.setAttribute("discovery-relays", relays.discoveryRelays.join(","));
  return widget;
};

/**
 * Everything else BitLogin does, in the panel (§SW19.4): the whole widget, as the account page has it, so nothing
 * needs a window of its own. Opened from "Account and more", or by a client that asked for it.
 */
const showAccount = () => {
  for (const id of ["ask", "ask-app", "choose", "signin", "unlock", "confirm", "wallet", "ecash", "files"]) $(id).hidden = true;
  // One widget at a time.
  $("widget-slot").replaceChildren();
  if (!$("account-slot").firstChild) {
    const widget = makeWidget();
    // In the panel the private key is shown only to someone who has just proved who they are (§SW19.4).
    if (inPanel) widget.setAttribute("fresh-secrets", "");
    widget.addEventListener("bitlogin-logout", () => {
      who = null;
      startOver();
    });
    widget.addEventListener("bitlogin-login", async () => {
      who = await readCachedSession();
      startOver();
    });
    $("account-slot").replaceChildren(widget);
  }
  status("");
  $("account").hidden = false;
  toClient({ t: "size", size: "tall" });
};
const leaveAccount = async () => {
  $("account").hidden = true;
  $("account-slot").replaceChildren();
  if (!found) return leave(false);
  who = await readCachedSession();
  startOver();
  who ? ask() : signIn();
};

/** Start again as whoever is signed in now: after a switch, or a sign-in as another account. */
const startOver = () => {
  preparing = null;
  profile = null;
  profileLoaded = Promise.resolve();
};

/**
 * The account chooser (docs/account-switching.md): the accounts kept signed in on this device, one row each. A
 * press switches to it, with no password, and the question comes next. "Sign in as another account" leaves
 * everyone here kept and offers the ordinary sign-in. The site is told nothing by any of this.
 */
const choose = async () => {
  if (finished) return;
  $("ask").hidden = true;
  $("ask-app").hidden = true;
  $("signin").hidden = true;
  let accounts = [];
  try {
    accounts = await (await theWorker()).accounts();
  } catch {
    /* no worker: there is nothing to choose from, and sign-in is offered */
  }
  if (accounts.length === 0) return addAccount();
  $("choose-site").textContent = found.site;
  $("accounts").replaceChildren(
    ...accounts.map((account) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "connect-account-row";
      row.dataset.pubkey = account.pubkey;
      const pic = document.createElement("span");
      pic.className = "connect-avatar";
      const letter = () => pic.replaceChildren(document.createTextNode((account.name || "?").trim().slice(0, 1).toUpperCase()));
      letter();
      if (account.picture) {
        const img = new Image();
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        img.onload = () => pic.replaceChildren(img);
        img.onerror = letter;
        img.src = account.picture;
      }
      const text = document.createElement("span");
      text.className = "text";
      const name = document.createElement("strong");
      name.textContent = account.name || "An account with no name";
      const key = document.createElement("span");
      key.className = "connect-key";
      key.textContent = `${account.npub.slice(0, 14)}…${account.npub.slice(-6)}${account.active ? " · signed in now" : ""}`;
      text.append(name, key);
      row.append(pic, text);
      row.addEventListener("click", () => switchTo(account.pubkey));
      const item = document.createElement("li");
      item.append(row);
      return item;
    })
  );
  status("Choose the account to use at this site.");
  $("choose").hidden = false;
};

const switchTo = async (pubkey) => {
  $("choose").hidden = true;
  status("Switching.");
  let result = null;
  try {
    result = await (await theWorker()).switchAccount(pubkey);
  } catch {
    result = null;
  }
  if (result?.locked) {
    // Kept under the lock: opened first, and then this is done.
    const lock = await (await theWorker()).lockStatus().catch(() => null);
    if (lock?.on) return unlock(lock, () => switchTo(pubkey));
  }
  if (!result?.pubkey) {
    status("That account is no longer kept on this device. Choose another, or sign in to it.");
    return choose();
  }
  who = await readCachedSession();
  startOver();
  if (!who) return signIn();
  ask();
};

/** Sign in as an account that is not kept here. Everyone kept stays kept, and so does the lock. */
const addAccount = async () => {
  $("choose").hidden = true;
  try {
    await (await theWorker()).addAccount();
  } catch {
    return status(`That didn't work. Close this ${here} and try again.`);
  }
  who = null;
  startOver();
  signIn();
  status("Sign in as the account you want to use at this site.");
};

const allow = async (button, forFamily = false, withMore = false) => {
  if (!found || !who || performance.now() - askedAt < TOO_SOON_MS) return;
  button.disabled = true;
  // Both answers to the family question are kept: "Just this one" stops it being asked again for thirty days.
  const asFamily = forFamily && familyShown();
  if (!forFamily && familyShown()) declineFamily(found.family);
  status(found.wants ? "Handing over a key that can do only what you just read." : "Handing over a key that can only sign.");
  let session = null;
  try {
    session = await prepare();
    await Promise.race([profileLoaded, new Promise((done) => setTimeout(done, PROFILE_WAIT_MS))]);
    const remember = !lockOn && $(found.wants ? "remember-app" : "remember").checked;
    const ok = await found.grant(session, who.name, remember, asFamily, withMore);
    $("ask").hidden = true;
    $("ask-app").hidden = true;
    if (!ok) return status(`That didn't work, and nothing was handed over. Close this ${here} and try again from the site that opened it.`);
    // Written down at the sign-in address, for the list of sites allowed. A record only: it lets nothing sign.
    const at = Math.floor(Date.now() / 1000);
    if (asFamily) {
      recordAllowed({ site: found.family, members: [found.site, offer.site], pubkey: who.pubkey, at, until: at + (found.knownFamily ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec), remembered: true });
      status(`Done. Every ${familyDomain(found.family)} site can sign notes as you until you sign out of one of them.`);
      setTimeout(() => leave(true), 700);
      return;
    }
    // A site let read private messages is kept seven days at most, as the signer keeps it.
    const messages = [...found.has, ...(withMore ? found.more : [])].includes("messages");
    recordAllowed({ site: found.site, pubkey: who.pubkey, at, until: at + (remember ? (found.known && !messages ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec) : SIGN_LIMITS.visitSec), remembered: remember, ...(found.wants ? { wants: found.wants } : {}) });
    const how = remember ? "until you sign out of it" : "for this visit";
    status(found.wants ? `Done. That application can act as you, as you allowed, ${how}.` : withMore ? `Done. That site can sign notes as you, and do what you just allowed, ${how}.` : `Done. That site can sign notes as you ${how}.`);
    setTimeout(() => leave(true), 700);
  } catch {
    $("ask").hidden = true;
    $("ask-app").hidden = true;
    status("That didn't work, and nothing was handed over. If you signed in with a browser extension or a phone, this isn't offered for it yet.");
  } finally {
    session?.destroy();
  }
};
$("allow").addEventListener("click", () => allow($("allow")));
$("allow-family").addEventListener("click", () => allow($("allow-family"), true));
$("allow-more").addEventListener("click", () => allow($("allow-more"), false, true));
$("allow-app").addEventListener("click", () => allow($("allow-app")));
$("deny-app").addEventListener("click", () => leave(false));
$("switch").addEventListener("click", choose);
$("switch-app").addEventListener("click", choose);
$("add-account").addEventListener("click", addAccount);
$("deny-3").addEventListener("click", () => leave(false));
$("deny").addEventListener("click", () => leave(false));
$("deny-2").addEventListener("click", () => leave(false));
$("advanced").addEventListener("click", showAccount);
$("open-files").addEventListener("click", async () => {
  who = await readCachedSession();
  if (!who) return status("Sign in first, below. Then your files open here.");
  await (await theWorker()).restore().catch(() => null);
  void showFiles();
});
$("open-ecash").addEventListener("click", async () => {
  // The wallet needs someone signed in: the widget below is where that is done.
  who = await readCachedSession();
  if (!who) return status("Sign in first, below. Then your wallet opens here.");
  await (await theWorker()).restore().catch(() => null);
  void showEcash();
});
$("account-back").addEventListener("click", () => void leaveAccount());
$("close").addEventListener("click", () => leave(false));

/** What the person is asked first, once the signer is found: as the window has always done it. */
const begin = async (wantsSwitch) => {
  who = await readCachedSession();
  const lock = await (await theWorker()).lockStatus().catch(() => null);
  lockOn = lock?.on === true;
  // Asked for the chooser (a site's "switch account"), or more than one account is kept here and this site has
  // not been allowed before: which one is asked, never assumed.
  const kept = await (await theWorker()).accounts().catch(() => []);
  const firstTime = !loadAllowed().some((entry) => entry.site === found.site);
  const wantsChooser = wantsSwitch || (kept.length > 1 && firstTime);
  if (lock?.locked) unlock(lock, wantsChooser ? choose : undefined);
  else if (wantsChooser && kept.length > 0) choose();
  else if (!who) signIn();
  else ask();
};

/**
 * The client says hello first, from the page that shows this one: its origin is the browser's word, and it is
 * listened to only if BitLogin lists it. Until then nothing is said to anyone. A client sends it again until it
 * hears "ready", so a hello sent before this page was listening is not lost.
 */
const helloFromClient = () =>
  new Promise((resolve) => {
    const on = (e) => {
      if (e.source !== window.parent || window.parent === window) return;
      const hello = readPanelHello(e.data);
      if (!hello || !panelClientAllowed(e.origin, location.origin)) return;
      removeEventListener("message", on);
      clearTimeout(giveUp);
      resolve({ ...hello, client: e.origin });
    };
    addEventListener("message", on);
    const giveUp = setTimeout(() => {
      removeEventListener("message", on);
      resolve(null);
    }, 10_000);
  });

if (inPanel) {
  document.body.classList.add("panel");
  for (const element of document.querySelectorAll("[data-panel-only]")) element.hidden = false;
  $("panel-me").textContent = location.host;
  const hello = window.parent === window ? null : await helloFromClient();
  if (!hello) {
    for (const element of document.querySelectorAll(".panel-foot, .panel-close")) element.hidden = true;
    status(`This panel is shown inside ${PANEL_CLIENTS.map((origin) => new URL(origin).host).join(" or ")}, where a world asks to sign you in. There is nothing to do here on its own.`);
  } else {
    client = hello.client;
    $("panel-client").textContent = `shown by ${new URL(client).host}`;
    toClient({ t: "ready" });
    if (hello.mode === "account") showAccount();
    else if (hello.mode === "files" || hello.mode === "wallet") {
      // Straight to the file browser or the wallet. Both are the signed-in person's: with nobody signed in, the
      // account page comes first, and says why.
      who = await readCachedSession();
      const restored = who ? await (await theWorker()).restore().catch(() => null) : null;
      if (!restored) {
        showAccount();
        status(hello.mode === "files" ? "Sign in first, below. Then open Files." : "Sign in first, below. Then open your wallet.");
      } else void (hello.mode === "files" ? showFiles() : showEcash());
    } else {
      status("Looking for the world that asked.");
      found = await findEmbeddedSigner({ inClient: true, world: hello.world });
      if (!found) status("BitLogin's signer wasn't found in that world, so there is nothing to allow. The world may not support it yet.");
      else await begin(hello.mode === "switch");
    }
  }
} else if (!window.opener) {
  status("This window is opened by a site, when you ask it to sign in with BitLogin. There is nothing to do here on its own.");
} else {
  found = await findEmbeddedSigner();
  if (!found) {
    status("No BitLogin signer was found in the page that opened this window, so there is nothing to allow. The site may not support this, or your browser kept the two apart.");
  } else {
    await begin(location.hash === "#switch");
  }
}
