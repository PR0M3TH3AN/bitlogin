#!/usr/bin/env node
/*
 * Tests relays the way BitLogin uses them, and says which ones can store an
 * account.
 *
 *   npm run build && node scripts/relay-probe.mjs                # the built-in lists
 *   node scripts/relay-probe.mjs wss://a.example wss://b.example # these relays
 *   node scripts/relay-probe.mjs --discover                      # candidates from NIP-66 monitors
 *   node scripts/relay-probe.mjs --recheck probe.json            # are earlier test events still held?
 *   node scripts/relay-probe.mjs --json probe.json ...           # also save the raw results
 *
 * "Online" is not the property that matters. A capsule is signed by a key that
 * exists only to sign that capsule, so it is in nobody's web of trust and has
 * no history, and it is a kind-30078 event of about 6 KB. A relay is useful
 * only if it takes THAT from a stranger and gives it back. So this publishes
 * capsule-shaped events from throwaway keys and reads them back, several
 * times, and reports each relay's own refusal text.
 *
 * It publishes throwaway events to public relays. They hold random bytes.
 * Results describe the network as seen from THIS machine: a VPN or a
 * datacenter address changes what relays allow.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nostr = await import(path.join(root, "packages/core/dist/nostr/index.js"));
const crypto = await import(path.join(root, "packages/core/dist/crypto/index.js"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const jsonOut = option("--json");
const recheck = option("--recheck");
const explicit = args.filter((a) => a.startsWith("wss://"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (url) => url.replace("wss://", "");

/** Where NIP-66 relay monitors publish. Any relay carrying kind 30166 works. */
const MONITOR_RELAYS = ["wss://relay.nostr.watch", "wss://relaypag.es", "wss://monitorlizard.nostr1.com", "wss://nos.lol", "wss://relay.primal.net"];
const ROUNDS = 4;
const GAP_BETWEEN_ROUNDS_MS = 15_000;

function capsule(kind) {
  const key = crypto.generatePrivateKey();
  // Same envelope shape and overall size as real capsules: credential ~5.9 KB, recovery ~1.9 KB.
  const content = JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: randomBytes(12).toString("base64url"),
    ciphertext: randomBytes(kind === "credential" ? 4096 : 1024).toString("base64url"),
  });
  return nostr.signNostrEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", kind === "credential" ? "bitlogin:password:v1" : "bitlogin:recovery:v1"]],
      content,
      pubkey: crypto.getPublicKeyHex(key),
    },
    key,
  );
}

async function relayInfo(url) {
  try {
    const response = await fetch(url.replace("wss://", "https://"), {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(8000),
    });
    const doc = await response.json();
    const l = doc.limitation ?? {};
    return {
      software: String(doc.software ?? "").split("/").pop()?.replace(/\.git$/u, "").slice(0, 20),
      auth_required: l.auth_required === true,
      payment_required: l.payment_required === true,
      restricted_writes: l.restricted_writes === true,
      max_message_length: l.max_message_length,
    };
  } catch {
    return null;
  }
}

async function readBack(url, event) {
  const conn = new nostr.RelayConnection(url);
  try {
    const got = await conn.queryOnce(
      { kinds: [30078], authors: [event.pubkey], "#d": [event.tags[0][1]], limit: 2 },
      6000,
    );
    return got.some((e) => e.id === event.id);
  } catch {
    return null; // could not ask
  } finally {
    conn.close();
  }
}

async function publish(url, event) {
  const conn = new nostr.RelayConnection(url);
  try {
    const reply = await conn.publish(event, 8000);
    return { ok: reply.ok, message: String(reply.message ?? "").slice(0, 120) };
  } catch (error) {
    return { ok: false, connection: true, message: String(error?.message ?? error).slice(0, 120) };
  } finally {
    conn.close();
  }
}

async function discover() {
  const found = new Map();
  await Promise.all(
    MONITOR_RELAYS.map(async (monitorRelay) => {
      const conn = new nostr.RelayConnection(monitorRelay);
      try {
        const events = await conn.queryOnce({ kinds: [30166], limit: 500 }, 10_000);
        for (const event of events) {
          const url = event.tags.find((t) => t[0] === "d")?.[1]?.replace(/\/$/u, "");
          if (!url?.startsWith("wss://") || url.includes(".onion")) continue;
          const requirements = event.tags.filter((t) => t[0] === "R").map((t) => t[1]);
          const kinds = event.tags.filter((t) => t[0] === "k").map((t) => t[1]);
          // A monitor's word is a reason to TEST a relay, never a reason to use it.
          if (requirements.some((r) => r === "auth" || r === "payment") || kinds.includes("!30078")) continue;
          found.set(url, (found.get(url) ?? 0) + 1);
        }
      } catch {
        // a monitor relay that is down just contributes nothing
      } finally {
        conn.close();
      }
    }),
  );
  return [...found.keys()];
}

if (recheck) {
  const saved = JSON.parse(readFileSync(recheck, "utf8"));
  const minutes = Math.round((Date.now() - saved.at) / 60_000);
  console.log(`Re-reading test events published ${minutes} minutes ago.\n`);
  for (const [url, relay] of Object.entries(saved.relays)) {
    const stored = relay.events.filter((e) => e.stored);
    if (stored.length === 0) continue;
    const still = (await Promise.all(stored.map((e) => readBack(url, e.event)))).filter((x) => x === true).length;
    console.log(`${short(url).padEnd(34)} still holds ${still} of ${stored.length}`);
  }
  process.exit(0);
}

let targets = explicit;
if (flag("--discover")) {
  const candidates = await discover();
  console.log(`NIP-66 monitors list ${candidates.length} relays that claim open writes.`);
  targets = [...new Set([...targets, ...candidates])].slice(0, Number(option("--limit") ?? 60));
}
if (targets.length === 0) {
  targets = [...new Set([...nostr.BUILTIN_VAULT_RELAYS, ...nostr.BUILTIN_DISCOVERY_RELAYS])];
}

const relays = Object.fromEntries(targets.map((url) => [url, { info: null, events: [] }]));
await Promise.all(targets.map(async (url) => (relays[url].info = await relayInfo(url))));

for (let round = 0; round < ROUNDS; round += 1) {
  await Promise.all(
    targets.map(async (url) => {
      // The order a real sign-up uses: recovery capsule, then the credential capsule a moment later.
      for (const kind of ["recovery", "credential"]) {
        const event = capsule(kind);
        const reply = await publish(url, event);
        const stored = reply.ok ? (await readBack(url, event)) === true : false;
        relays[url].events.push({ kind, ...reply, stored, event });
        await sleep(1000);
      }
    }),
  );
  if (round < ROUNDS - 1) await sleep(GAP_BETWEEN_ROUNDS_MS);
}

const rows = targets.map((url) => {
  const relay = relays[url];
  const total = relay.events.length;
  const stored = relay.events.filter((e) => e.stored).length;
  const connectionFailures = relay.events.filter((e) => e.connection).length;
  const refusals = [...new Set(relay.events.filter((e) => !e.ok && !e.connection).map((e) => e.message))];
  const acceptedNotServed = relay.events.filter((e) => e.ok && !e.stored).length;
  let verdict = "usable";
  if (stored === 0) verdict = connectionFailures === total ? "unreachable" : "refuses";
  else if (stored < total) verdict = "unreliable";
  return { url, verdict, stored, total, connectionFailures, acceptedNotServed, refusals, info: relay.info };
});

const order = { usable: 0, unreliable: 1, refuses: 2, unreachable: 3 };
rows.sort((a, b) => order[a.verdict] - order[b.verdict] || b.stored - a.stored);
console.log(`\n${"relay".padEnd(34)} ${"verdict".padEnd(11)} stored  notes`);
for (const row of rows) {
  const notes = [
    row.connectionFailures ? `${row.connectionFailures} connection failures` : "",
    row.acceptedNotServed ? `${row.acceptedNotServed} accepted but not returned` : "",
    ...row.refusals.map((r) => `refused: "${r}"`),
    row.info?.payment_required ? "NIP-11 says payment required" : "",
    row.info?.auth_required ? "NIP-11 says auth required" : "",
    row.info?.restricted_writes ? "NIP-11 says restricted writes" : "",
    row.info?.software ? `(${row.info.software})` : "",
  ].filter(Boolean);
  console.log(`${short(row.url).padEnd(34)} ${row.verdict.padEnd(11)} ${String(row.stored).padStart(2)}/${row.total}   ${notes.join("; ")}`);
}
console.log(`\nusable: ${rows.filter((r) => r.verdict === "usable").map((r) => r.url).join(" ")}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: Date.now(), relays }, null, 2));
  console.log(`\nSaved to ${jsonOut}. Re-read later with --recheck ${jsonOut} to see which relays kept the events.`);
}
process.exit(0);
