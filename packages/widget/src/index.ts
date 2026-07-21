/** Entry point: any static site includes this file and drops in <bitlogin-auth>. */
import { BitLoginAuthElement } from "./element.js";

if (!customElements.get("bitlogin-auth")) {
  customElements.define("bitlogin-auth", BitLoginAuthElement);
}

export { BitLoginAuthElement } from "./element.js";
export { WorkerClient } from "./worker/workerClient.js";
export { createNip07Provider } from "./provider.js";
export type { BitLoginConfig } from "./config.js";
