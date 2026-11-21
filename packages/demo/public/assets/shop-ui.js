// Buying, and what was bought (docs/paying.md), on BitLogin's own sign-in page and panel. A site names a listing and
// nothing else. This page fetches the listing and checks it, asks the selling service for a quote as the buyer, shows
// what it is, whose it is and what each part costs, pays from the person's own ecash wallet on a press, keeps the
// receipt with the account, and hands the site the receipt. The site never signs as the buyer and never sees the wallet.
//
// Nothing a listing, a seller or a service says is ever put on the page as markup: every word is written as text.
const $ = (id) => document.getElementById(id);
const sats = (n) => `${Number(n).toLocaleString()} ${n === 1 ? "sat" : "sats"}`;
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const TOO_SOON_MS = 900;
/**
 * A local copy of BitLogin (on this machine, or a private network) may be tried against a selling service there.
 * The real address never is.
 */
const local = /^(?:localhost|127(?:\.[0-9]{1,3}){3}|10(?:\.[0-9]{1,3}){3}|192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2})$/u.test(location.hostname);
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const day = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const lasts = (receipt) => (receipt.expiresAt ? `Yours until ${day(receipt.expiresAt)}.` : "Yours to keep.");

let lib = null;
const load = async () => (lib ??= await import("../vendor/bitlogin/bitlogin-ecash.js"));
const servicesKnown = () => {
  const tried = local ? lib.localService(document.documentElement.dataset.unlockService) : null;
  return tried ? [...lib.UNLOCK_SERVICES, tried] : [...lib.UNLOCK_SERVICES];
};

/** Whether a world is told what was bought from it without a question each time. The person's own to turn off. */
const TELL_KEY = "bitlogin:tell-worlds:v1:";
export const tellsWorlds = (pubkey) => {
  try {
    return storage()?.getItem(TELL_KEY + pubkey) !== "0";
  } catch {
    return true;
  }
};
const setTellsWorlds = (pubkey, on) => {
  try {
    storage()?.setItem(TELL_KEY + pubkey, on ? "1" : "0");
  } catch {
    /* kept for this page only */
  }
};

/**
 * Whether this account is known, in this browser, to hold any receipt. Until it is, signing in to a site looks
 * nothing up: most people have bought nothing, and their sign-in is not made to wait on a relay.
 */
const HAS_KEY = "bitlogin:has-receipts:v1:";
const hasAny = (pubkey) => {
  try {
    return storage()?.getItem(HAS_KEY + pubkey) === "1";
  } catch {
    return false;
  }
};

/**
 * A test service's session (BitUnlock's sandbox), kept for as long as this page is: every buyer call carries its
 * id, and its token settles a pretend payment. Made only on a local copy of BitLogin, for a service named there.
 */
const sandboxSession = async (service) => {
  const at = `bitlogin:sandbox:v1:${service.endpoint}`;
  try {
    const kept = JSON.parse(window.sessionStorage.getItem(at) ?? "null");
    if (kept?.sessionId && kept?.token) return kept;
  } catch {
    /* a new one is made */
  }
  const made = await lib.openSandboxSession(service);
  try {
    window.sessionStorage.setItem(at, JSON.stringify(made));
  } catch {
    /* it lasts as long as this purchase does */
  }
  return made;
};

/** The account's receipts, each read and checked: only those a known service signed, for this account. */
const kept = async (worker, pubkey) => {
  const services = servicesKnown();
  const state = await worker.pay.receipts();
  const receipts = [];
  for (const item of state.receipts) {
    const receipt = lib.readReceipt(item.event, services);
    if (receipt && receipt.buyer === pubkey) receipts.push({ receipt, title: item.title, via: item.via });
  }
  try {
    if (receipts.length) storage()?.setItem(HAS_KEY + pubkey, "1");
  } catch {
    /* looked up again next time */
  }
  return { receipts, offline: state.offline, unsaved: state.unsaved };
};

/**
 * The receipts a site's signer is handed, so that it can answer "do they have this?" with no question: those for
 * listings that are the site's own (sold by a key it publishes with, or bought through it), and no others. None
 * where the person turned that off.
 */
export async function receiptsFor(worker, pubkey, site, { always = false } = {}) {
  // At sign-in, an account not known to hold any receipt has nothing looked up. Where BitLogin's page is shown for
  // a site that is signed in already, they are always looked up: something bought on another device is found then.
  if (!tellsWorlds(pubkey) || (!always && !hasAny(pubkey))) return [];
  await load();
  const [mine, world] = await Promise.all([kept(worker, pubkey), lib.readWorld(site, { local })]);
  const now = Date.now() / 1000;
  return mine.receipts.filter(({ receipt, via }) => lib.belongsTo(receipt.listing, { publishers: world.publishers, site }, via) && lib.receiptGood(receipt, { buyer: pubkey, listing: receipt.listing, now })).map(({ receipt }) => receipt.event);
}

/**
 * A site asked to buy something.
 *   worker      the page's headless signer, with a full session
 *   pubkey      who is buying
 *   resize      tell a client the size this would like
 *   request     { site, listing }: the site that asked, and the listing's coordinate
 *   done        ({ receipt, delivery? } | null), once
 *   openWallet  called after a "no" where the person asked for their wallet, to add sats
 */
export async function openShop({ worker, pubkey, resize, request, done, openWallet }, lookedAtService = false) {
  const views = [...document.querySelectorAll("#shop [data-shop]")];
  let finished = false;
  const show = (name) => {
    for (const view of views) view.hidden = view.dataset.shop !== name;
    $("shop-error").hidden = true;
    $("shop-nav").hidden = name !== "done";
  };
  const finish = (result) => {
    if (finished) return;
    finished = true;
    $("shop").hidden = true;
    done(result);
  };
  /** It can't go on: say why, and offer only Close. */
  const stop = (text) => {
    show("done");
    $("shop-done").textContent = text;
  };
  const working = (text) => {
    show("working");
    $("shop-working").textContent = text;
  };
  $("shop-close").onclick = () => finish(null);
  // Asked by a site, or opened from Purchases to finish something: then there is no site to name, or to answer.
  $("shop-for").hidden = !request.site;
  $("shop-site").textContent = request.site || "";
  $("shop").hidden = false;
  show("loading");
  resize("tall");

  let wallet;
  let listing;
  let client;
  try {
    await load();
    const services = servicesKnown();
    // The receipts first: something already held is never charged for again.
    const mine = await kept(worker, pubkey);
    const held = lib.bestReceipt(mine.receipts.filter((item) => item.receipt.listing === request.listing).map((item) => item.receipt), { buyer: pubkey, listing: request.listing, now: Date.now() / 1000 });
    if (held) {
      const item = mine.receipts.find((entry) => entry.receipt.event.id === held.event.id);
      const world = request.site ? await lib.readWorld(request.site, { local }) : { publishers: [] };
      // Its own listing, and the person lets worlds be told: the receipt is handed over as `have` would hand it.
      if (!request.site || (tellsWorlds(pubkey) && lib.belongsTo(held.listing, { publishers: world.publishers, site: request.site }, item?.via))) {
        // Said for a moment, so a press isn't met with nothing.
        stop(`You already have this. ${lasts(held)} Nothing was charged.`);
        $("shop-nav").hidden = true;
        return void setTimeout(() => finish({ receipt: held.event }), 1300);
      }
      $("shop-held-title").textContent = item?.title || held.listing.slice(71);
      $("shop-held-lasts").textContent = lasts(held);
      show("held");
      resize("menu");
      const askedAt = performance.now();
      $("shop-hide").onclick = () => finish(null);
      $("shop-show").onclick = () => performance.now() - askedAt >= TOO_SOON_MS && finish({ receipt: held.event });
      return;
    }

    // The listing, from the relays its service names. Which service is not yet known: each one BitLogin knows is asked.
    const keys = { pubkey, auth: (req) => worker.pay.auth(req), open: (from, sealed) => worker.nip44Decrypt(from, sealed) };
    const clients = services.map((service) => ({ service, client: lib.createUnlockClient(service, keys) }));
    const policies = await Promise.all(clients.map(({ client: c }) => c.policy().catch(() => null)));
    // A local copy may also be told of a test relay where test listings are kept, so none need be put on a public one.
    const testRelays = local ? (document.documentElement.dataset.listingRelays ?? "").split(",").map((url) => url.trim()).filter(Boolean).slice(0, 3) : [];
    const found = await worker.pay.listing(request.listing, [...testRelays, ...policies.flatMap((policy) => policy?.relays ?? [])]);
    listing = lib.readListing(found.event, request.listing, services);
    if (!listing) return stop(found.event ? "This site asked to sell something BitLogin can't check: its listing isn't signed by its seller, or names a service BitLogin doesn't buy from. Nothing was spent." : found.answered ? "This site asked to sell something no relay knows of. Nothing was spent." : "No relay answered just now, so what is for sale couldn't be looked up. Nothing was spent.");
    // Nothing in a world is sold under the floor (owner, 2026-11-21): the service's fee would be too large a part of it.
    if (lib.underFloor(listing)) return stop(`This is listed at ${sats(listing.priceSats)}, under the ${sats(lib.LEAST_PRICE_SATS)} that is the least anything in a world is sold for. Nothing was spent.`);
    const at = clients.findIndex(({ service }) => service.pubkey === listing.service.pubkey);
    if (!policies[at]) return stop(`${host(listing.service.endpoint)}, which sells this, didn't answer. Nothing was spent.`);
    client = clients[at].client;
    // A test service, with pretend sats (BitUnlock's sandbox): tried only on a local copy of BitLogin. Its policy
    // says so itself. It is given a session of its own, and what it is owed is settled by a call and by no wallet.
    const pretend = policies[at].sandbox === true;
    if (pretend) {
      if (!local) return stop("This names a test service, which is tried only on a test copy of BitLogin. Nothing was spent.");
      client = lib.createUnlockClient(listing.service, keys, { sandbox: await sandboxSession(listing.service) });
    }

    // The service's own record of this account's receipts: one bought on another device is found here, and kept.
    const theirs = await client.receipts().catch(() => []);
    const already = lookedAtService ? null : theirs.find((row) => row.status === "active" && lib.receiptGood(row.receipt, { buyer: pubkey, listing: listing.coordinate, now: Date.now() / 1000 }));
    if (already) {
      await worker.pay.keep([{ event: already.receipt.event, title: listing.title, via: "" }]).catch(() => null);
      $("shop").hidden = true;
      return void openShop({ worker, pubkey, resize, request, done, openWallet }, true);
    }

    if (!pretend) {
      wallet = lib.createEcashWallet(worker.ecash);
      await wallet.open();
    }
    // A purchase begun before is taken up again, by the order BitLogin kept the id of: never a second order beside
    // one that is open, and never a second charge for a part that was paid.
    const settings = await worker.pay.settings().catch(() => ({ orders: [] }));
    let open = settings.orders.find((o) => o.listing === listing.coordinate && o.service === listing.service.endpoint) ?? null;
    let plan = null;
    try {
      plan = open ? await client.resume(listing, open.order) : null;
      // The order it kept is finished or gone: it is let go, and the service is asked whether it knows of another.
      if (open && !plan) {
        await worker.pay.dropOrder(open.order).catch(() => null);
        open = null;
      }
      plan ??= await client.resume(listing);
    } catch (err) {
      if (err?.code !== "withdrawn") throw err;
      // It can't be finished. Said plainly, with what went: nothing here pretends otherwise.
      if (open) await worker.pay.dropOrder(open.order).catch(() => null);
      return stop(`${open?.title || listing.title} was withdrawn by its seller, and can't be finished. Anything you paid toward it went to the seller or to ${host(listing.service.endpoint)}, and can't be taken back from here: ask the seller.`);
    }
    const key = open?.key ?? lib.newOrderKey();
    plan ??= await client.quote(listing, key);
    const seller = await worker.pay.profile(listing.seller).catch(() => ({ name: "" }));

    // What each unpaid part costs to send, from the mint: before anything is spent.
    const due = plan.legs.filter((leg) => leg.status !== "settled");
    const quotes = new Map();
    let fees = 0;
    if (!pretend && wallet.state().mints.length > 0) {
      for (const leg of due) {
        const quoted = await wallet.quote(leg.invoice);
        if (quoted.amount !== leg.sats) return stop("The seller's service answered with a payment plan that doesn't match what was asked. Nothing was spent.");
        quotes.set(leg.hash, quoted);
        fees += quoted.feeReserve;
      }
    }
    const owed = due.reduce((sum, leg) => sum + leg.sats, 0);
    const have = pretend ? 0 : wallet.balance();
    const mint = quotes.size ? [...quotes.values()][0].mint : "";
    const line = (label, value) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    };
    const who = { seller: "To the seller", service: `To ${host(listing.service.endpoint)}, its fee` };
    $("shop-title").textContent = listing.title;
    $("shop-seller").textContent = seller.name || "an account with no name";
    $("shop-seller-key").textContent = listing.seller;
    $("shop-price").textContent = plan.totalSats.toLocaleString();
    $("shop-lines").replaceChildren(
      ...plan.legs.map((leg) => line(`${who[leg.role] ?? "To another party"}${leg.status === "settled" ? " (paid already)" : ""}`, sats(leg.sats))),
      ...(pretend ? [line("Paid with", "pretend sats: a test service")] : quotes.size ? [line("Routing fees, at most", sats(fees)), line("From", host(mint)), line("You hold", sats(have))] : [])
    );
    $("shop-service").textContent = host(listing.service.endpoint);
    $("shop-lasts").textContent = listing.termSeconds ? `It lasts ${Math.round(listing.termSeconds / 86_400) || 1} ${Math.round(listing.termSeconds / 86_400) > 1 ? "days" : "day"}.` : "The receipt says how long it lasts.";
    const short = !pretend && (quotes.size === 0 || have < owed + fees);
    $("shop-short").hidden = !short;
    $("shop-short").textContent = !short ? "" : quotes.size === 0 ? "You have no ecash wallet yet. Open your wallet, add sats, then ask again." : `This needs up to ${sats(owed + fees)}, and you hold ${sats(have)}. Open your wallet, add sats, then ask again.`;
    $("shop-yes").hidden = short;
    $("shop-yes").disabled = false;
    $("shop-yes").textContent = owed === 0 ? "Finish, nothing more to pay" : owed < plan.totalSats ? `Pay the ${sats(owed)} that is left` : `Pay ${sats(owed)}`;
    $("shop-wallet").hidden = !short;
    show("confirm");
    resize("tall");
    const askedAt = performance.now();
    $("shop-no").onclick = () => finish(null);
    $("shop-wallet").onclick = () => {
      finish(null);
      openWallet?.();
    };
    $("shop-yes").onclick = async () => {
      if (performance.now() - askedAt < TOO_SOON_MS) return;
      $("shop-yes").disabled = true;
      working("Paying.");
      try {
        // The order is kept with the account before a sat moves: its id, and the key it was asked with. If that
        // can't be written down, nothing is paid.
        try {
          await worker.pay.keepOrder({ listing: listing.coordinate, order: plan.order, key, service: listing.service.endpoint, title: listing.title, via: request.site || "" });
        } catch {
          return stop("This purchase couldn't be written down first, so nothing was paid. Ask again.");
        }
        const bought = await lib.completePurchase({
          client,
          listing,
          plan,
          progress: (step) => working("paying" in step ? `Paying ${sats(step.paying.sats)} ${step.paying.role === "seller" ? "to the seller" : step.paying.role === "service" ? `to ${host(listing.service.endpoint)}` : "to another party"}.` : "Paid. Fetching your receipt."),
          pay: async (leg) => {
            if (pretend) return client.settle(leg.hash).then(() => ({}));
            const quoted = quotes.get(leg.hash) ?? (await wallet.quote(leg.invoice));
            if (quoted.amount !== leg.sats) throw new Error("A part of the payment plan changed. Nothing more was spent.");
            return wallet.pay(quoted);
          }
        });
        // Kept before the site hears of it: in this browser first, then on the account's relays.
        const saved = await worker.pay.keep([{ event: bought.receipt.event, title: listing.title, via: request.site || "" }]).catch(() => null);
        await worker.pay.dropOrder(plan.order).catch(() => null);
        stop(`Bought. ${lasts(bought.receipt)}${saved ? "" : " The receipt couldn't be kept just now: the seller's service holds it too, and it is fetched again when you next ask."}`);
        $("shop-nav").hidden = true;
        setTimeout(() => finish({ receipt: bought.receipt.event, ...(bought.delivery ? { delivery: bought.delivery } : {}) }), 1400);
      } catch (err) {
        // Stopped after money went: said plainly, with how much, that there is no receipt yet, and how it is finished.
        if (err?.name === "PartPaidError" && err.cause_?.code === "withdrawn") return stop(`${sats(err.paidSats)} of this was paid, and then its seller withdrew it, so it can't be finished. What was paid can't be taken back from here: ask the seller.`);
        if (err?.name === "PartPaidError") return stop(`${sats(err.paidSats)} of this was paid, and the rest didn't go. You have no receipt yet, and what was paid can't be taken back from here. It is kept under Purchases as not finished: finish it there, or ask again from the site. What was paid is counted, and never charged twice.`);
        // Paid in full, and no receipt yet: the order is kept, and finished from Purchases or by asking again.
        if (err?.code === "receipt" || err?.code === "delivery") return stop(`${err.message} It is kept under Purchases as not finished.`);
        // Nothing went, now or before: the order need not be remembered. One that money ever went into is kept.
        if (plan.legs.every((leg) => leg.status !== "settled")) await worker.pay.dropOrder(plan.order).catch(() => null);
        stop(err?.message || "That didn't work, and nothing was paid.");
      }
    };
  } catch (err) {
    stop(err?.code === "sold" || err?.code === "plan" || err?.code === "service" ? err.message : "That couldn't be set up. Nothing was spent.");
  }
}

/** What the person has bought, opened on its own from the account page. */
export async function openLibrary({ worker, pubkey, resize, done }) {
  $("library").hidden = false;
  $("library-list").replaceChildren();
  $("library-open").replaceChildren();
  $("library-open-row").hidden = true;
  $("library-empty").hidden = true;
  $("library-note").textContent = "Opening your receipts.";
  $("library-tell").checked = tellsWorlds(pubkey);
  $("library-tell").onchange = () => setTellsWorlds(pubkey, $("library-tell").checked);
  $("library-back").onclick = () => {
    $("library").hidden = true;
    done();
  };
  resize("tall");
  try {
    await load();
    let mine = await kept(worker, pubkey);
    // What each service says of them now: a receipt bought on another device is kept here, and one taken back is said to be.
    const status = new Map();
    const keys = { pubkey, auth: (req) => worker.pay.auth(req), open: (from, sealed) => worker.nip44Decrypt(from, sealed) };
    let asked = true;
    for (const service of servicesKnown()) {
      const rows = await lib.createUnlockClient(service, keys).receipts().catch(() => null);
      if (!rows) {
        asked = false;
        continue;
      }
      const fresh = rows.filter((row) => !mine.receipts.some((item) => item.receipt.event.id === row.receipt.event.id));
      if (fresh.length) {
        mine = await worker.pay
          .keep(fresh.map((row) => ({ event: row.receipt.event, title: "", via: "" })))
          .then(() => kept(worker, pubkey))
          .catch(() => mine);
      }
      for (const row of rows) status.set(row.receipt.event.id, row.status);
    }
    // Purchases begun and not finished: shown as that, each with one press to finish it. Never as bought.
    const settings = await worker.pay.settings().catch(() => ({ orders: [] }));
    $("library-open-row").hidden = settings.orders.length === 0;
    $("library-open").replaceChildren(
      ...settings.orders.map((order) => {
        const row = document.createElement("li");
        const what = document.createElement("span");
        what.className = "library-what";
        const name = document.createElement("strong");
        name.textContent = order.title || order.listing.slice(71);
        const where = document.createElement("small");
        where.textContent = `Not finished. ${order.via ? `Begun at ${host(order.via)}, ` : "Begun "}${day(order.at)}.`;
        what.append(name, where);
        const go = document.createElement("button");
        go.type = "button";
        go.className = "btn secondary";
        go.textContent = "Finish";
        go.onclick = () => {
          $("library").hidden = true;
          void openShop({ worker, pubkey, resize, request: { site: "", listing: order.listing }, done: () => void openLibrary({ worker, pubkey, resize, done }) });
        };
        row.append(what, go);
        return row;
      })
    );
    const now = Date.now() / 1000;
    $("library-note").textContent = mine.offline
      ? "No relay answered, so this is the copy kept in this browser."
      : mine.unsaved
        ? "Kept in this browser. Your relays didn't take the latest receipt yet: it is sent again next time."
        : asked
          ? "Kept with your account, sealed so only you can read them."
          : "Kept with your account. The selling service didn't answer just now, so whether any was taken back isn't known.";
    $("library-empty").hidden = mine.receipts.length > 0;
    $("library-list").replaceChildren(
      ...mine.receipts.map(({ receipt, title, via }) => {
        const row = document.createElement("li");
        const what = document.createElement("span");
        what.className = "library-what";
        const name = document.createElement("strong");
        name.textContent = title || receipt.listing.slice(71);
        const where = document.createElement("small");
        where.textContent = `${via ? `Bought at ${host(via)}, ` : "Bought "}${day(receipt.issuedAt)}`;
        what.append(name, where);
        const state = document.createElement("span");
        const gone = status.get(receipt.event.id) === "revoked" ? "Taken back" : receipt.expiresAt && receipt.expiresAt <= now ? "Ran out" : "";
        state.className = `library-state${gone ? " gone" : ""}`;
        state.textContent = gone || (receipt.expiresAt ? `Until ${day(receipt.expiresAt)}` : "Yours to keep");
        row.append(what, state);
        return row;
      })
    );
  } catch {
    $("library-note").textContent = "Your receipts couldn't be opened just now. Nothing was changed.";
  }
}
