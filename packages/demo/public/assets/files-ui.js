// The file browser (docs/files.md), on BitLogin's own sign-in page and panel. This draws; the engine is
// bitlogin-files.js, loaded only when the browser is opened, and the worker keeps the index and signs each
// permission note, for one file at one server.
//
// Nothing a file, a folder, a server or a site says is ever put on the page as markup: every word is written as text.
const $ = (id) => document.getElementById(id);
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let lib = null;

/**
 * Open the file browser.
 *   worker   the page's headless signer, with a full session
 *   resize   tell a client the size this would like
 *   request  where a site asked: { site, save: { name, type, bytes, private } } or { site, pick: true }
 *   done     for a request, called once with the answer or null; otherwise called when Back is pressed at the top
 */
export async function openFiles({ worker, resize, request, done }) {
  const views = [...document.querySelectorAll("#files [data-files]")];
  let files = null;
  let at = "root";
  let opened = "";
  /** A file or folder picked up to be moved or copied: carried until it is put down somewhere. */
  let carrying = null;
  let finished = false;
  let view = "loading";

  const error = (text) => {
    $("files-error").textContent = text || "";
    $("files-error").hidden = !text;
  };
  const busy = (text) => {
    $("files-busy").textContent = text || "";
    $("files-busy").hidden = !text;
    for (const control of document.querySelectorAll("#files button, #files input")) control.disabled = !!text;
  };
  const fail = (err) => error([err?.message || "That didn't work.", err?.reason ? `The server said: ${err.reason}` : ""].filter(Boolean).join(" "));
  /** Do something that takes a moment: say what, and say plainly if it didn't work. */
  const doing = async (text, work) => {
    error("");
    busy(text);
    try {
      return await work();
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      busy("");
      if (view === "browse") draw();
    }
  };
  const finish = (result) => {
    if (finished) return;
    finished = true;
    $("files").hidden = true;
    done(result);
  };
  /** The browser's copy is on screen while relays are asked: read-only until they answer. */
  let checking = false;
  /** The servers people use, asked for once in an opening, where a server is chosen. */
  let rankedOnce = null;
  const show = (name) => {
    view = name;
    for (const section of views) section.hidden = section.dataset.files !== name;
    error("");
    $("files-nav").hidden = name === "loading" || (!!request && name === "browse");
    $("files-back").textContent = name === "servers" && files?.servers().length ? "Back to your files" : "Back to your account";
  };

  /** One line to type, or a yes and a no, in the page itself: a framed page may not use the browser's own prompts. */
  const ask = (label, value) =>
    new Promise((resolve) => {
      const form = $("files-ask");
      const input = $("files-ask-input");
      $("files-ask-label").textContent = label;
      input.hidden = value === undefined;
      input.value = value ?? "";
      form.hidden = false;
      if (value !== undefined) {
        input.focus();
        input.select();
      }
      const end = (answer) => {
        form.hidden = true;
        form.onsubmit = null;
        resolve(answer);
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        end(value === undefined ? true : input.value);
      };
      $("files-ask-no").onclick = () => end(null);
    });

  const sizeOf = (bytes) => lib.sizeWords(bytes);

  /** Hand a file to the person's device, as a browser saves any download. */
  const download = ({ name, type, bytes }) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
    const link = el("a", { href: url, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const actsFor = (target, isFolder, file) => {
    const act = (label, run, danger = false) => el("button", { type: "button", className: danger ? "danger" : "", onclick: run }, label);
    const acts = [];
    if (!isFolder) {
      acts.push(act("Download", () => void doing(`Fetching ${file.name}.`, async () => download(await files.get(file.id)))));
      if (!file.key) {
        acts.push(
          act("Copy link", async (e) => {
            try {
              await navigator.clipboard.writeText(files.link(file.id));
              e.target.textContent = "Link copied";
            } catch {
              error(`Its link is ${files.link(file.id)}`);
            }
          })
        );
      }
    }
    acts.push(
      act("Rename", async () => {
        const name = await ask("New name", isFolder ? target.name : file.name);
        if (name) await doing("Renaming.", () => files.rename(isFolder ? { folder: target.id } : { file: file.id }, name));
      })
    );
    acts.push(act("Move", () => carry({ how: "move", ...(isFolder ? { folder: target.id } : { file: file.id }), name: isFolder ? target.name : file.name })));
    if (!isFolder) acts.push(act("Copy", () => carry({ how: "copy", file: file.id, name: file.name })));
    acts.push(
      act(
        "Delete",
        async () => {
          const what = isFolder ? `Delete the folder "${target.name}" and everything in it? This can't be undone.` : `Delete "${file.name}"? This can't be undone.`;
          if (await ask(what)) await doing("Deleting.", () => files.remove(isFolder ? { folder: target.id } : { file: file.id }));
        },
        true
      )
    );
    return el("div", { className: "files-acts" }, ...acts);
  };

  const carry = (what) => {
    carrying = what;
    opened = "";
    draw();
  };

  const draw = () => {
    const drive = files.drive();
    try {
      drive.folder(at);
    } catch {
      at = "root";
    }
    const here = drive.folder(at);
    const picking = !!request?.pick;
    // The path, each step a way back.
    const path = drive.path(at);
    $("files-path").replaceChildren(
      ...path.flatMap((folder, i) => [
        ...(i ? [el("span", { className: "sep", ariaHidden: "true" }, "›")] : []),
        el("button", { type: "button", ariaCurrent: i === path.length - 1 ? "page" : "false", onclick: () => go(folder.id) }, folder.name)
      ])
    );
    const state = files.state();
    $("files-note").textContent = checking
      ? "Checking with your relays. This is what this browser held last time: nothing can be changed until they answer."
      : state.offline
      ? "No relay answered, so this is the list kept in this browser."
      : state.unsaved
        ? "Kept in this browser. Your relays didn't take the latest change yet: it is sent again next time."
        : "";
    $("files-note").hidden = !$("files-note").textContent;

    const rows = [];
    for (const folder of drive.children(at)) {
      const id = `d:${folder.id}`;
      const count = folder.files.length + drive.children(folder.id).length;
      const row = el(
        "div",
        { className: "files-row" },
        el("button", { type: "button", className: "files-open", onclick: () => go(folder.id) }, el("span", { className: "files-icon folder", ariaHidden: "true" }), el("span", { className: "files-name" }, folder.name)),
        el("span", { className: "files-meta" }, count === 1 ? "1 thing" : `${count} things`)
      );
      if (!request && !carrying && folder.id !== "root") {
        row.append(el("button", { type: "button", className: "files-more", ariaExpanded: String(opened === id), onclick: () => ((opened = opened === id ? "" : id), draw()) }, "More"));
      }
      rows.push(el("li", {}, row, ...(opened === id ? [actsFor(folder, true)] : [])));
      rows[rows.length - 1].dataset.folder = folder.name;
    }
    for (const file of [...here.files].sort((a, b) => a.name.localeCompare(b.name))) {
      const id = `f:${file.id}`;
      const row = el(
        "div",
        { className: "files-row" },
        el(
          "button",
          { type: "button", className: "files-open", onclick: () => (picking ? void send(file) : ((opened = opened === id ? "" : id), draw())) },
          el("span", { className: "files-icon file", ariaHidden: "true" }),
          el("span", { className: "files-name" }, file.name)
        ),
        el("span", { className: `files-seal ${file.key ? "private" : ""}` }, file.key ? "Private" : "Public"),
        el("span", { className: "files-meta" }, sizeOf(file.size))
      );
      if (picking) row.append(el("button", { type: "button", className: "files-more", onclick: () => void send(file) }, "Send this"));
      else if (!request && !carrying) row.append(el("button", { type: "button", className: "files-more", ariaExpanded: String(opened === id), onclick: () => ((opened = opened === id ? "" : id), draw()) }, "More"));
      const item = el("li", {}, row, ...(opened === id && !picking ? [actsFor(here, false, file)] : []));
      item.dataset.file = file.name;
      rows.push(item);
    }
    $("files-list").replaceChildren(...rows);
    $("files-empty").hidden = rows.length > 0;

    $("files-carry").hidden = !carrying;
    if (carrying) $("files-carry-what").textContent = `${carrying.how === "copy" ? "Copying" : "Moving"} "${carrying.name}". Go to where it should be, then put it here.`;
    $("files-tools").hidden = !!carrying || !!request?.pick;
    $("files-upload").hidden = !!request;
    $("files-private").closest("label").hidden = !!request;
    $("files-save").hidden = !request?.save;
    $("files-pick").hidden = !request?.pick;

    const usage = files.usage();
    $("files-usage").textContent = usage.length ? `You keep ${usage.map((u) => `${sizeOf(u.bytes)} in ${u.files} ${u.files === 1 ? "file" : "files"} on ${host(u.server)}`).join(", and ")}.` : "You keep nothing on any server yet.";
    $("files-go-servers").hidden = !!request;
    resize("tall");
  };
  const go = (id) => {
    at = id;
    opened = "";
    draw();
  };

  $("files-carry-cancel").onclick = () => carry(null);
  $("files-carry-here").onclick = async () => {
    const what = carrying;
    carrying = null;
    await doing(what.how === "copy" ? "Copying." : "Moving.", () => (what.how === "copy" ? files.copy(what.file, at) : files.move(what.folder ? { folder: what.folder } : { file: what.file }, at)));
  };
  $("files-new-folder").onclick = async () => {
    const name = await ask("Name the new folder", "New folder");
    if (name) await doing("Making the folder.", () => files.newFolder(at, name));
  };
  $("files-upload").onclick = () => $("files-input").click();
  $("files-input").onchange = async () => {
    const chosen = $("files-input").files?.[0];
    $("files-input").value = "";
    if (!chosen) return;
    const keepPrivate = $("files-private").checked;
    await doing(`Saving ${chosen.name}${keepPrivate ? ", sealed" : ""}.`, async () => files.put(at, { name: chosen.name, type: chosen.type, bytes: new Uint8Array(await chosen.arrayBuffer()) }, { private: keepPrivate }));
  };

  /** A site offered a file: saved where the person is now, under the name they see, public or private as they choose. */
  $("files-save").onsubmit = async (e) => {
    e.preventDefault();
    const keepPrivate = $("files-save-private").checked;
    const saved = await doing(`Saving ${$("files-save-name").value}${keepPrivate ? ", sealed" : ""}.`, () =>
      files.put(at, { name: $("files-save-name").value, type: request.save.type, bytes: request.save.bytes }, { private: keepPrivate })
    );
    if (saved) finish({ saved: { name: saved.name, size: request.save.bytes.length, private: keepPrivate, ...(keepPrivate ? {} : { url: files.link(saved.id) }) } });
  };
  $("files-save-no").onclick = () => finish(null);
  $("files-pick-no").onclick = () => finish(null);
  /** The person chose a file for a site: it is fetched, opened if private, and handed over. That one file, and no other. */
  const send = async (file) => {
    const sure = await ask(`Send "${file.name}" to ${host(request.site)}?${file.key ? " It is private: the site will be able to read it." : ""}`);
    if (!sure) return;
    const got = await doing(`Fetching ${file.name}.`, () => files.get(file.id));
    if (got) finish({ file: { name: got.name, type: got.type, bytes: got.bytes, ...(file.key ? {} : { url: files.link(file.id) }) } });
  };

  // ---- Servers and storage.
  const drawServers = async () => {
    show("servers");
    resize("tall");
    const mine = files.servers();
    const usage = new Map(files.usage().map((u) => [u.server, u]));
    $("files-mine-empty").hidden = mine.length > 0;
    $("files-autopay").value = String(files.state().settings.autoPaySats);
    const tag = (state) => {
      const words = { free: "Free, any file", paid: "Charges", closed: "Not open to you", "too-large": "Free, any file", "media-only": "Pictures and video only", unknown: "Didn't say", unreachable: "Didn't answer" }[state] ?? "";
      return el("span", { className: `files-tag ${state === "paid" ? "paid" : state === "free" || state === "too-large" ? "free" : ""}` }, words);
    };
    $("files-mine").replaceChildren(
      ...mine.map((server, i) => {
        const kept = usage.get(server);
        const name = el("span", { className: "mint" }, host(server));
        void files.check(server).then((check) => name.append(tag(check.state)));
        const row = el("li", {}, name, el("span", { className: "sats" }, kept ? sizeOf(kept.bytes) : "0 B", el("small", {}, kept ? ` in ${kept.files} ${kept.files === 1 ? "file" : "files"}` : "")));
        if (mine.length > 1) {
          row.append(el("button", { type: "button", className: "files-more", onclick: () => void doing("Saving your server list.", async () => (await files.setServers(mine.filter((s) => s !== server)), void drawServers())) }, "Stop using"));
          if (i > 0) row.append(el("button", { type: "button", className: "files-more", onclick: () => void doing("Saving your server list.", async () => (await files.setServers([server, ...mine.filter((s) => s !== server)]), void drawServers())) }, "Make first"));
        }
        row.dataset.server = server;
        return row;
      })
    );
    // The servers people use are asked for here, where one is chosen, and once for this opening.
    rankedOnce ??= files.rank().catch(() => files.ranked());
    const picks = (await rankedOnce).filter((pick) => !files.servers().includes(pick.server));
    $("files-picks-note").textContent = picks.length
      ? "Counted from the server lists people publish on Nostr, people you follow first. A count is a hint, not a promise that a server will keep your files."
      : "No server lists were found just now. Enter a server's address below.";
    $("files-picks").replaceChildren(
      ...picks.map((pick) => {
        const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;
        const name = el("span", { className: "mint" }, host(pick.server));
        // Whether it would take a file from this account, and whether it charges: asked of the server itself.
        void files.check(pick.server).then((check) => name.append(tag(check.state)));
        const button = el(
          "button",
          { type: "button", className: "ecash-pick", onclick: () => void use(pick.server) },
          name,
          el("span", { className: "why" }, pick.byFollowed > 0 ? `${people(pick.byFollowed)} you follow${pick.by > pick.byFollowed ? `, ${pick.by} in all` : ""}` : `${pick.by} accounts`)
        );
        button.dataset.server = pick.server;
        return el("li", {}, button);
      })
    );
  };
  const use = async (address) => {
    const server = lib.cleanServer(address);
    if (!server) return error("That is not a server's address. It starts with https://.");
    await doing(`Asking ${host(server)}.`, async () => {
      const check = await files.check(server);
      if (check.state === "closed") throw Object.assign(new Error("That server doesn't take files from this account."), { reason: check.reason });
      if (check.state === "unreachable") throw new Error("Nothing answered at that address.");
      await files.setServers([...files.servers(), server]);
      $("files-server").value = "";
    });
    if (files.servers().includes(server)) request ? (show("browse"), draw()) : void drawServers();
  };
  $("files-server-form").onsubmit = (e) => {
    e.preventDefault();
    void use($("files-server").value);
  };
  $("files-pay-form").onsubmit = async (e) => {
    e.preventDefault();
    await doing("Saving.", () => files.setAutoPay(Math.max(0, Math.floor(Number($("files-autopay").value) || 0))));
  };
  $("files-go-servers").onclick = () => void drawServers();
  $("files-back").onclick = () => {
    if (view === "servers" && files.servers().length) return void (show("browse"), draw());
    finish(request ? null : undefined);
  };

  // ---- Open.
  $("files-for").hidden = !request;
  if (request) {
    $("files-site").textContent = request.site;
    $("files-for-what").textContent = request.save ? "Wants to save a file to your files" : "Asks you for a file";
  }
  $("files").hidden = false;
  show("loading");
  resize("tall");
  try {
    lib ??= await import("../vendor/bitlogin/bitlogin-files.js");
    // A server that charges is paid from the person's own ecash wallet: without asking up to what they allowed, and
    // otherwise only on a yes, here.
    const payer = {
      async quote(invoice) {
        const ecash = await import("../vendor/bitlogin/bitlogin-ecash.js");
        const wallet = ecash.createEcashWallet(worker.ecash);
        await wallet.open();
        const quoted = await wallet.quote(invoice);
        return { sats: quoted.amount + quoted.feeReserve, pay: async () => (await wallet.pay(quoted)).preimage };
      }
    };
    files = lib.createFiles(worker.drive, { payer, confirmPay: (sats, server) => ask(`${host(server)} charges up to ${sats} sats to keep this file. Pay it from your ecash wallet?`).then((yes) => !!yes) });
    // Opened by the person, with folders kept in this browser: those are on screen at once, marked as being checked,
    // and nothing can be changed until the relays have answered (docs/panel-speed-2026-11-23.md).
    if (!request) {
      const peeked = await files.peek().catch(() => null);
      if (peeked && peeked.folders.length > 0) {
        checking = true;
        $("files").classList.add("files-checking");
        show("browse");
        draw();
      }
    }
    if (request) await files.open();
    else {
      // The folders, then the account's own server list behind them: the folders are shown as soon as they are read,
      // and nothing is changed or uploaded until the server list is in too.
      await files.open({ servers: false });
      // Shown once the folders are read, even with none yet; the server list decides only whether nothing can be
      // kept yet, in which case the screen for choosing a server follows.
      {
        checking = true;
        $("files").classList.add("files-checking");
        show("browse");
        draw();
      }
      await files.loadServers();
    }
    if (files.serversRead()) {
      checking = false;
      $("files").classList.remove("files-checking");
    }
    // Otherwise the folders are read, but not the server list: they stay on screen, read-only (said below).
  } catch {
    show("browse");
    $("files-tools").hidden = true;
    error("Your files couldn't be opened. Nothing was changed.");
    $("files-nav").hidden = false;
    return;
  }
  if (request?.save) {
    // A site's file goes to that site's own folder unless the person goes somewhere else first.
    at = (await files.worldFolder(request.site)).id;
    $("files-save-name").value = lib.cleanFileName(request.save.name) || "file";
    $("files-save-size").textContent = `${sizeOf(request.save.bytes.length)}. It is saved in the folder shown above: go to another to save it there.`;
    $("files-save-private").checked = request.save.private !== false;
  }
  if (!files.serversRead()) return void (show("browse"), draw(), ($("files-note").textContent = "Your relays didn't answer for your server list, so nothing can be uploaded or changed now. Open Files again to try again."));
  if (files.servers().length === 0) return void drawServers();
  show("browse");
  draw();
}
