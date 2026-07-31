/** Transport policy shared by capsules, NWC credentials, and bootstrap lists. */

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/u.test(part))) return false;
  const numbers = octets.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) && numbers[0] === 127;
}

/**
 * Production relays require authenticated TLS. Cleartext WebSockets are
 * accepted only for explicit loopback development endpoints; names that
 * merely end in "localhost" are intentionally not trusted.
 */
export function isAllowedRelayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "wss:") return true;
  if (url.protocol !== "ws:") return false;
  return url.hostname === "localhost" || url.hostname === "[::1]" || isIpv4Loopback(url.hostname);
}
