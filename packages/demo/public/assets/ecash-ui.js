// The ecash wallet's screens (docs/ecash.md), on BitLogin's own sign-in page and panel. This draws; the wallet itself
// is bitlogin-ecash.js, loaded only when a wallet is opened, and the worker keeps what it holds.
//
// Nothing a mint, a token or an invoice says is ever put on the page as markup: every word is written as text.
const $ = (id) => document.getElementById(id);
const sats = (n) => `${Number(n).toLocaleString()} ${n === 1 ? "sat" : "sats"}`;
const host = (url) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
};
/** A press sooner than a person could have read the amount is ignored, as Allow is. */
const TOO_SOON_MS = 900;

let lib = null;
let wallet = null;

/**
 * Open the wallet's screens.
 *   worker   the page's headless signer, with a full session
 *   resize   tell a client the size this would like
 *   name     the name in their own profile, for the note that goes with a tip, where they have one
 *   request  where a site asked to be paid: { site, invoice }, or to send a tip: { site, tip: { to?, sats } }.
 *            Then `done` is called once, with the answer.
 *   done     ({ invoice, preimage? } | null) for a request; () for the wallet opened on its own, when Back is pressed at home
 */
export async function openEcash({ worker, name = "", resize, request, done }) {
  if (request) request = { ...request };
  /** A local copy of BitLogin may ask a lightning address on this machine. The real address never does. */
  const local = /^(?:localhost|127(?:\.[0-9]{1,3}){3}|10(?:\.[0-9]{1,3}){3}|192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2})$/u.test(location.hostname);
  /** The most a site may ask for at once with no receipt, kept with the account. 0: no limit. Read when the wallet opens. */
  let limitSats = 1000;
  const limit = () => limitSats;
  const over = (asked) => lib.overPayLimit(asked, limit());
  const limitWords = () => (limit() === 0 ? "no limit" : sats(limit()));
  /** Whom a tip is for, once found: the name in their own profile, and the lightning address it goes to. */
  let tipTo = null;
  const ownName = name;
  const views = [...document.querySelectorAll("#ecash [data-ecash]")];
  let funding = null;
  let polling = null;
  let finished = false;
  const stopPolling = () => {
    clearInterval(polling);
    polling = null;
    funding = null;
  };
  const error = (text) => {
    $("ecash-error").textContent = text || "";
    $("ecash-error").hidden = !text;
  };
  let current = "loading";
  const show = (name) => {
    current = name;
    for (const view of views) view.hidden = view.dataset.ecash !== name;
    error("");
    if (name === "setup") void loadPicks();
    $("ecash-nav").hidden = name === "loading" || name === "confirm" || name === "done" || (name === "home" && !!request) || (name === "setup" && !!request);
    $("ecash-back").textContent = name === "home" || name === "setup" ? "Back to your account" : "Back to the wallet";
    if (name !== "fund") stopPolling();
  };
  const fail = (err) => error(err?.message || "That didn't work. Nothing was spent.");
  const busy = (form, on) => {
    for (const el of form.querySelectorAll("button, input, select, textarea")) el.disabled = on;
  };
  const finish = (result) => {
    if (finished) return;
    finished = true;
    stopPolling();
    $("ecash").hidden = true;
    done(result);
  };

  $("ecash-for").hidden = !request;
  if (request) $("ecash-site").textContent = request.site;
  $("ecash").hidden = false;
  show("loading");
  resize("tall");

  /**
   * While the browser's own copy is on screen and relays are being asked (docs/panel-speed-2026-11-23.md): it is
   * shown, marked so, and nothing that spends, receives or changes is offered until the fresh answer is in.
   */
  let checking = false;
  /** The account's limit is still being read: its form waits for it. */
  let limiting = false;
  const holdWhileChecking = () => {
    for (const id of ["ecash-go-fund", "ecash-go-pay", "ecash-go-receive", "ecash-go-mint"]) $(id).disabled = checking;
    for (const el of $("ecash-limit-form").querySelectorAll("button, select")) el.disabled = checking || limiting;
  };
  const home = () => {
    const state = wallet.state();
    if (state.mints.length === 0 && !checking) return show("setup");
    $("ecash-total").textContent = wallet.balance().toLocaleString();
    holdWhileChecking();
    $("ecash-note").textContent = checking
      ? "Checking with your relays. This is what this browser held last time."
      : state.offline
      ? "No relay answered, so this is the copy kept in this browser. It is still yours to spend."
      : state.unsaved
        ? "Kept in this browser. Your relays didn't take the latest change yet: it is sent again next time."
        : "Kept with your account, sealed so only you can read it.";
    $("ecash-mints").replaceChildren(
      ...wallet.balances().map(({ mint, sats: held }) => {
        const row = document.createElement("li");
        const name = document.createElement("span");
        name.className = "mint";
        name.textContent = host(mint);
        const amount = document.createElement("span");
        amount.className = "sats";
        amount.textContent = held.toLocaleString();
        const unit = document.createElement("small");
        unit.textContent = held === 1 ? " sat" : " sats";
        amount.append(unit);
        row.append(name, amount);
        return row;
      })
    );
    $("ecash-fund-mint").replaceChildren(
      ...state.mints.map((mint) => {
        const option = document.createElement("option");
        option.value = mint;
        option.textContent = host(mint);
        return option;
      })
    );
    $("ecash-fund-mint").hidden = state.mints.length < 2;
    document.querySelector('label[for="ecash-fund-mint"]').hidden = state.mints.length < 2;
    $("ecash-limit").value = String(limit());
    show("home");
  };

  /** The site's question can't go on: say why, and offer only Close. Nothing was spent. */
  const stop = (text) => {
    show("done");
    $("ecash-done-text").textContent = text;
    $("ecash-nav").hidden = false;
    $("ecash-back").textContent = "Close";
  };
  const overLimit = (asked) =>
    stop(`This site asked for ${sats(asked)}, with no receipt. The most you allow for that is ${limitWords()}, so nothing was spent. You can change that limit in your wallet, then ask again from the site.`);
  /**
   * A tip (docs/paying.md): the site named who and how much, and nothing else. The lightning address is found here,
   * from that person's own signed profile, or for the site itself from its own /.well-known/nswp.json, and an
   * invoice for exactly that amount is asked of it.
   */
  const startTip = async () => {
    const { to, sats: asked } = request.tip;
    if (over(asked)) return overLimit(asked);
    if (wallet.state().mints.length === 0) return show("setup");
    try {
      let name = "";
      let address = "";
      if (to) {
        const found = await worker.pay.profile(to);
        if (!found.address) return stop(found.answered ? "That person's profile names no lightning address, so a tip can't reach them. Nothing was spent." : "No relay answered about that person just now, so a tip can't be sent. Nothing was spent.");
        ({ name, address } = found);
      } else {
        address = (await lib.readWorld(request.site, { local })).tip;
        if (!address) return stop("This site names no lightning address for tips. Nothing was spent.");
      }
      // The person tipped is told who, and in which world, by a note with the payment, where their address takes
      // one. The tipper may leave their name off: then the invoice is asked for again, with the shorter note.
      tipTo = { name, address, person: !!to, note: "", named: tipTo ? tipTo.named : true };
      const got = await lib.invoiceFromAddress(address, asked, { local, note: lib.tipNote(tipTo.named ? ownName : "", request.site) });
      tipTo.note = got.note;
      request.invoice = got.invoice;
    } catch (err) {
      return stop(err?.message || "That tip couldn't be set up. Nothing was spent.");
    }
    await review(request.invoice);
  };
  /** What a site's request goes on with, whenever the wallet is ready for it. */
  const goOn = () => (request.tip && !request.invoice ? startTip() : review(request.invoice));

  /** What it costs, before anything is spent: for a site's request, or an invoice pasted here. */
  let quoted = null;
  let askedAt = 0;
  const review = async (invoice) => {
    try {
      quoted = await wallet.quote(invoice);
    } catch (err) {
      if (request && err?.code === "no-wallet") return show("setup");
      if (request) return stop(err?.message || "That invoice can't be paid from here.");
      return fail(err);
    }
    // A payment a site asked for leaves no receipt, so it is held to the person's own limit. A tip is also held to
    // the amount the site named: the mint's reading of the invoice has to agree.
    if (request && over(quoted.amount)) return overLimit(quoted.amount);
    if (request?.tip && quoted.amount !== request.tip.sats) return stop("That lightning address answered with an invoice for a different amount. Nothing was spent.");
    const need = quoted.amount + quoted.feeReserve;
    const have = wallet.balance(quoted.mint);
    $("ecash-confirm-title").textContent = request?.tip ? "Send this tip?" : request ? "Pay this site?" : "Pay this invoice?";
    // Who it is for, in BitLogin's words. A name is anyone's to claim, so the address it goes to is shown beside it.
    $("ecash-pay-what").hidden = !request;
    $("ecash-pay-what").textContent = !request ? "" : !tipTo ? "A payment to this site." : tipTo.person ? `A tip to ${tipTo.name || "an account with no name"}, at this lightning address:` : "A tip to this site, at the lightning address it names:";
    $("ecash-pay-to").hidden = !tipTo;
    $("ecash-pay-to").textContent = tipTo?.address ?? "";
    $("ecash-no-receipt").hidden = !request;
    $("ecash-note-row").hidden = !tipTo?.note;
    $("ecash-note-text").textContent = tipTo?.note ?? "";
    $("ecash-note-name-row").hidden = !ownName;
    $("ecash-note-name").checked = tipTo?.named !== false;
    $("ecash-note-name").disabled = false;
    $("ecash-pay-no").textContent = request?.tip ? "Don't send" : "Don't pay";
    $("ecash-pay-amount").textContent = quoted.amount.toLocaleString();
    $("ecash-pay-fee").textContent = sats(quoted.feeReserve);
    $("ecash-pay-mint").textContent = host(quoted.mint);
    $("ecash-pay-have").textContent = sats(have);
    const short = have < need;
    $("ecash-short").hidden = !short;
    $("ecash-short").textContent = short ? `This needs up to ${sats(need)}, and you hold ${sats(have)} at that mint.` : "";
    $("ecash-pay-yes").hidden = short;
    $("ecash-pay-yes").disabled = false;
    $("ecash-pay-yes").textContent = `${request?.tip ? "Send" : "Pay"} ${sats(quoted.amount)}`;
    $("ecash-pay-fund").hidden = !short;
    show("confirm");
    resize("menu");
    askedAt = performance.now();
  };

  $("ecash-pay-yes").onclick = async () => {
    if (!quoted || performance.now() - askedAt < TOO_SOON_MS) return;
    $("ecash-pay-yes").disabled = true;
    $("ecash-pay-yes").textContent = "Paying…";
    try {
      const result = await wallet.pay(quoted);
      show("done");
      $("ecash-done-text").textContent = `Paid ${sats(result.paid)}${result.fee > 0 ? `, and ${sats(result.fee)} in fees` : ""}. You have ${sats(wallet.balance())} left.`;
      if (request) return setTimeout(() => finish({ invoice: quoted.invoice, ...(result.preimage ? { preimage: result.preimage } : {}) }), 1200);
      $("ecash-nav").hidden = false;
    } catch (err) {
      $("ecash-pay-yes").textContent = `${request?.tip ? "Send" : "Pay"} ${sats(quoted.amount)}`;
      $("ecash-pay-yes").disabled = false;
      fail(err);
    }
  };
  $("ecash-pay-no").onclick = () => (request ? finish(null) : home());
  $("ecash-pay-fund").onclick = () => show("fund");

  /** Add a mint, once it has answered as one, and go on to what the person came for. */
  const useMint = async (address, controls) => {
    for (const el of controls) el.disabled = true;
    error("");
    try {
      await wallet.addMint(address);
      $("ecash-mint").value = "";
      request ? await goOn() : home();
    } catch (err) {
      fail(err);
    } finally {
      for (const el of controls) el.disabled = false;
    }
  };
  $("ecash-mint-form").onsubmit = (e) => {
    e.preventDefault();
    void useMint($("ecash-mint").value, [...e.target.querySelectorAll("button, input"), ...$("ecash-picks").querySelectorAll("button")]);
  };
  /**
   * The mints people recommend on Nostr (NIP-87), the person's own follows first. A count is all it is: anyone can
   * publish a recommendation, and the screen says so.
   */
  let picksLoaded = false;
  const loadPicks = async () => {
    if (picksLoaded) return;
    picksLoaded = true;
    let picks = [];
    try {
      picks = (await worker.ecash.recommended()).filter((pick) => !wallet.state().mints.includes(pick.mint));
    } catch {
      picks = [];
    }
    $("ecash-picks-note").textContent = picks.length
      ? "Counted from recommendations on Nostr, people you follow first. Anyone can publish one, so treat a count as a hint and not a guarantee."
      : "No recommendations were found just now. Enter a mint's address below.";
    $("ecash-picks").replaceChildren(
      ...picks.map((pick) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ecash-pick";
        button.dataset.mint = pick.mint;
        const name = document.createElement("span");
        name.className = "mint";
        name.textContent = host(pick.mint);
        const why = document.createElement("span");
        why.className = "why";
        const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;
        why.textContent = pick.byFollowed > 0 ? `${people(pick.byFollowed)} you follow${pick.by > pick.byFollowed ? `, ${pick.by} in all` : ""}` : `${pick.by} ${pick.by === 1 ? "account" : "accounts"}`;
        button.append(name, why);
        button.onclick = () => void useMint(pick.mint, [...$("ecash-picks").querySelectorAll("button"), ...$("ecash-mint-form").querySelectorAll("button, input")]);
        const item = document.createElement("li");
        item.append(button);
        return item;
      })
    );
  };

  $("ecash-fund-form").onsubmit = async (e) => {
    e.preventDefault();
    busy(e.target, true);
    error("");
    try {
      funding = await wallet.fund($("ecash-fund-mint").value || wallet.state().mints[0], Number($("ecash-fund-amount").value));
      const svg = new DOMParser().parseFromString(lib.renderQrSvg(`lightning:${funding.invoice}`, "The invoice, as a code to scan"), "image/svg+xml").documentElement;
      $("ecash-qr").replaceChildren(document.importNode(svg, true));
      $("ecash-invoice-text").textContent = funding.invoice;
      $("ecash-fund-status").textContent = "Waiting for the payment.";
      e.target.hidden = true;
      $("ecash-invoice").hidden = false;
      const mine = funding;
      polling = setInterval(async () => {
        if (funding !== mine) return;
        // A panel its client has hidden checks nothing: the next look, once it is shown again, will.
        if (document.documentElement.dataset.panelHidden) return;
        try {
          if (!(await wallet.claim(mine))) return;
          const added = mine.amount;
          stopPolling();
          if (request) return void goOn();
          home();
          $("ecash-note").textContent = `Added ${sats(added)}.`;
        } catch (err) {
          stopPolling();
          fail(err);
        }
      }, 2500);
    } catch (err) {
      fail(err);
    } finally {
      busy(e.target, false);
    }
  };
  $("ecash-invoice-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(funding?.invoice ?? "");
      $("ecash-invoice-copy").textContent = "Copied";
    } catch {
      $("ecash-invoice-copy").textContent = "Select the text above to copy it";
    }
  };

  $("ecash-receive-form").onsubmit = async (e) => {
    e.preventDefault();
    busy(e.target, true);
    error("");
    try {
      const got = await wallet.receive($("ecash-token").value);
      $("ecash-token").value = "";
      home();
      $("ecash-note").textContent = `Received ${sats(got.sats)}.`;
    } catch (err) {
      fail(err);
    } finally {
      busy(e.target, false);
    }
  };

  $("ecash-pay-form").onsubmit = async (e) => {
    e.preventDefault();
    busy(e.target, true);
    error("");
    await review($("ecash-pay-invoice").value);
    busy(e.target, false);
  };

  const openFund = () => {
    $("ecash-fund-form").hidden = false;
    $("ecash-invoice").hidden = true;
    $("ecash-fund-amount").value = "";
    $("ecash-invoice-copy").textContent = "Copy invoice";
    show("fund");
  };
  $("ecash-go-fund").onclick = openFund;
  $("ecash-pay-fund").onclick = openFund;
  $("ecash-go-receive").onclick = () => show("receive");
  $("ecash-go-pay").onclick = () => {
    $("ecash-pay-invoice").value = "";
    show("invoice");
  };
  $("ecash-go-mint").onclick = () => show("setup");
  $("ecash-back").onclick = () => {
    if (current === "done" && request) return finish(null);
    if (current === "home" || (current === "setup" && wallet.state().mints.length === 0)) return finish(request ? null : undefined);
    if (request) return void goOn();
    home();
  };
  $("ecash-limit-form").onsubmit = async (e) => {
    e.preventDefault();
    // Not before the limit is read: what is saved is written on it.
    if (checking || limiting) return;
    busy(e.target, true);
    try {
      const kept = await worker.pay.setLimit(Number($("ecash-limit").value));
      limitSats = kept.limitSats;
      $("ecash-limit-note").textContent = `Saved${kept.unsaved ? " in this browser. Your relays didn't take it yet: it is sent again next time" : ""}. ${limit() === 0 ? "A site can ask you for any amount at once with no receipt. You still see it and press before anything is paid." : `A site can ask you for at most ${sats(limit())} at once with no receipt.`}`;
    } catch {
      $("ecash-limit-note").textContent = "That couldn't be saved, so the limit is as it was.";
    }
    $("ecash-limit").value = String(limit());
    busy(e.target, false);
  };
  // Their name left off the note, or put back: the invoice is asked for again, since the note is part of it.
  $("ecash-note-name").onchange = async () => {
    if (!tipTo || !request?.tip) return;
    tipTo.named = $("ecash-note-name").checked;
    $("ecash-note-name").disabled = true;
    $("ecash-pay-yes").disabled = true;
    request.invoice = "";
    await startTip();
  };

  try {
    lib ??= await import("../vendor/bitlogin/bitlogin-ecash.js");
    wallet = lib.createEcashWallet(worker.ecash);
    // The limit is the account's. Where it can't be read, the default stands: never "no limit" by accident.
    const readLimit = () =>
      worker.pay
        .settings()
        .then((kept) => lib.cleanPayLimit(kept.limitSats))
        .catch(() => lib.PAY_LIMIT.default);
    if (request) {
      const limitRead = readLimit();
      // A site is asking to be paid: nothing is shown until the wallet and the limit are both read, as before.
      await wallet.open();
      limitSats = await limitRead;
    } else {
      // The wallet opened by the person: what this browser held is on screen at once, marked as being checked.
      const peeked = await wallet.peek().catch(() => null);
      if (peeked && peeked.mints.length > 0) {
        checking = true;
        home();
        resize("tall");
      }
      await wallet.open({ check: false });
      checking = false;
      // The limit, for its own form, behind the balance: the form waits for it.
      limiting = true;
      // Read here, as on its own: a failed read leaves the form held, as a change is written on what was read.
      void worker.pay
        .settings()
        .then((kept) => {
          limitSats = lib.cleanPayLimit(kept.limitSats);
          limiting = false;
          if (current === "home") home();
        })
        .catch(() => {});
      // Then each mint is asked whether what is held is unspent, behind the balance, which is redrawn if it changed.
      void wallet
        .check()
        .then(() => current === "home" && home())
        .catch(() => {});
    }
  } catch (err) {
    show("done");
    $("ecash-done-text").textContent = "Your wallet couldn't be opened. Nothing was changed.";
    $("ecash-nav").hidden = false;
    $("ecash-back").textContent = "Close";
    $("ecash-back").onclick = () => finish(request ? null : undefined);
    return;
  }
  if (request) await goOn();
  else home();
}
