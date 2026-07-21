/** Host-page-configurable options for <bitlogin-auth> (§19.1, §19.6). */
export interface BitLoginConfig {
  vaultRelayUrls?: string[];
  discoveryRelayUrls?: string[];
}

export function readConfigFromElement(el: HTMLElement): BitLoginConfig {
  const vaultAttr = el.getAttribute("vault-relays");
  const discoveryAttr = el.getAttribute("discovery-relays");
  return {
    vaultRelayUrls: vaultAttr ? vaultAttr.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    discoveryRelayUrls: discoveryAttr ? discoveryAttr.split(",").map((s) => s.trim()).filter(Boolean) : undefined
  };
}
