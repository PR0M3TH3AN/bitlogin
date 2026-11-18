#!/usr/bin/env node
/*
 * Signs BitLogin's relay-list event (spec §19.1) and, if asked, publishes it.
 *
 *   npm run build
 *   node scripts/sign-relay-list.mjs relay-list.json            # sign, print the event
 *   node scripts/sign-relay-list.mjs relay-list.json --publish  # sign and send to the relays
 *   node scripts/sign-relay-list.mjs --pubkey                   # print the public key to pin
 *
 * relay-list.json:
 *   { "version": 2,
 *     "vaultRelays": ["wss://..."],        relays to ADD for storing accounts
 *     "discoveryRelays": ["wss://..."],    relays to ADD for profile lookups
 *     "deprecated": ["wss://..."] }        earlier additions to stop using
 *
 * The maintainer key is read from the BITLOGIN_MAINTAINER_NSEC environment
 * variable (an nsec or 64-character hex). It is never taken from the command
 * line, where it would land in shell history and process listings, and it is
 * never written anywhere. Run this on a machine you trust.
 *
 * What a signed list can and cannot do, so the key is handled accordingly:
 * it can add relays, up to one fewer than a client pins; it cannot remove a
 * built-in relay, read an account, or forge one. Losing the key means losing
 * the ability to update old clients, and a new key needs a client release.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nostr = await import(path.join(root, "packages/core/dist/nostr/index.js"));
const account = await import(path.join(root, "packages/core/dist/account/index.js"));
const crypto = await import(path.join(root, "packages/core/dist/crypto/index.js"));

const args = process.argv.slice(2);
const secret = process.env.BITLOGIN_MAINTAINER_NSEC;
if (!secret) {
  console.error("Set BITLOGIN_MAINTAINER_NSEC to the maintainer key (nsec or hex) for this one command.");
  process.exit(1);
}
const key = account.decodeEverydayPrivateKey(secret);
const pubkey = crypto.getPublicKeyHex(key);

if (args.includes("--pubkey")) {
  console.log(pubkey);
  process.exit(0);
}

const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: node scripts/sign-relay-list.mjs relay-list.json [--publish]");
  process.exit(1);
}
const list = JSON.parse(readFileSync(file, "utf8"));
const event = nostr.buildBootstrapListEvent(list, key);

const pinned = nostr.MAINTAINER_PUBLIC_KEY_HEX;
if (pinned && pinned !== pubkey) {
  console.error(`This key (${pubkey}) is not the one clients pin (${pinned}). They would ignore this list.`);
  process.exit(1);
}
if (!pinned) {
  console.error("Note: no maintainer key is pinned in packages/core/src/nostr/bootstrap.ts yet, so no client reads this.");
}

const sets = { vault: nostr.mergeRelayLists(nostr.BUILTIN_VAULT_RELAYS, list, "vault"), discovery: nostr.mergeRelayLists(nostr.BUILTIN_DISCOVERY_RELAYS, list, "discovery") };
const dropped = (list.vaultRelays ?? []).filter((url) => !sets.vault.includes(url) && !(list.deprecated ?? []).includes(url));
console.error(`version ${list.version}: clients will use ${sets.vault.length} vault relays and ${sets.discovery.length} discovery relays.`);
if (dropped.length) {
  console.error(`Over the cap (a list may add at most ${nostr.maxRemoteAdditions(nostr.BUILTIN_VAULT_RELAYS.length)}), so these are ignored: ${dropped.join(" ")}`);
}

if (!args.includes("--publish")) {
  console.log(JSON.stringify(event, null, 2));
  process.exit(0);
}

const targets = [...new Set([...sets.vault, ...sets.discovery])];
const pool = new nostr.RelayPool(targets);
const outcomes = await pool.publishAll(event, 8000);
pool.closeAll();
for (const outcome of outcomes) {
  console.error(`${outcome.result.ok ? "accepted" : "refused "} ${outcome.relayUrl}${outcome.result.ok ? "" : `  ${outcome.result.message}`}`);
}
const accepted = outcomes.filter((o) => o.result.ok).length;
console.error(`\n${accepted} of ${targets.length} relays hold version ${list.version}.`);
process.exit(accepted > 0 ? 0 : 1);
