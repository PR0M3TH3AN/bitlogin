// The embedded signer's page (docs/sign-in-window.md). All of it is in the widget package; this starts it.
import { startEmbeddedSigner } from "../vendor/bitlogin/bitlogin-signer.js";

const signer = startEmbeddedSigner();
// Opened on its own, it does nothing, and says so.
if (!signer.embedded) document.getElementById("alone").hidden = false;
