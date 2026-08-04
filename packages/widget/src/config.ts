/** Host-page-configurable options for <bitlogin-auth> (§19.1, §19.6). */
import { parseOnrampConfig, type OnrampConfig } from "./onramp.js";
import { parseGoogleOnrampConfig, type GoogleOnrampConfig } from "./driveOnramp.js";

export interface BitLoginConfig {
  vaultRelayUrls?: string[];
  discoveryRelayUrls?: string[];
  /** Centralized on-ramp via an external service (centralized-onramps.md
   *  §CO3.2/§CO5). Absent unless the host explicitly configures one --
   *  BitLogin ships no centralized dependency by default. */
  onramp?: OnrampConfig;
  /** Serverless Google on-ramp (§CO3.3): the credential lives in the user's
   *  own Google Drive app data; no third party exists. Enabled by the host
   *  registering an OAuth client ID. */
  onrampGoogle?: GoogleOnrampConfig;
}

export function readConfigFromElement(el: HTMLElement): BitLoginConfig {
  const vaultAttr = el.getAttribute("vault-relays");
  const discoveryAttr = el.getAttribute("discovery-relays");
  return {
    vaultRelayUrls: vaultAttr ? vaultAttr.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    discoveryRelayUrls: discoveryAttr ? discoveryAttr.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    onramp: parseOnrampConfig({
      url: el.getAttribute("onramp-url"),
      name: el.getAttribute("onramp-name"),
      providers: el.getAttribute("onramp-providers")
    }),
    onrampGoogle: parseGoogleOnrampConfig(el.getAttribute("onramp-google-client-id"))
  };
}
