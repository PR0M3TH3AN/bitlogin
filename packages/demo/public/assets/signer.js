// The embedded signer's page (docs/sign-in-window.md). All of it is in the widget package; this starts it.
import { startEmbeddedSigner } from "../vendor/bitlogin/bitlogin-signer.js";

/** Relays other than BitLogin's own list, where the page names them. The live page names none. */
const relayList = (value) => (value || "").split(",").map((url) => url.trim()).filter(Boolean);
const signer = startEmbeddedSigner({
  vaultRelays: relayList(document.documentElement.dataset.vaultRelays),
  discoveryRelays: relayList(document.documentElement.dataset.discoveryRelays)
});
// Opened on its own, it does nothing, and says so.
if (!signer.embedded) document.getElementById("alone").hidden = false;
