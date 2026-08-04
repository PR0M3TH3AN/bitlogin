/** Host-page-configurable options for <bitlogin-auth> (§19.1, §19.6). */
import { parseOnrampConfig, type OnrampConfig } from "./onramp.js";

export interface BitLoginConfig {
  vaultRelayUrls?: string[];
  discoveryRelayUrls?: string[];
  /** Centralized on-ramp (centralized-onramps.md §CO5). Absent unless the
   *  host explicitly configures one -- BitLogin ships no centralized
   *  dependency by default. */
  onramp?: OnrampConfig;
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
    })
  };
}
