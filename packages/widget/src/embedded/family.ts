/**
 * A family of sites (docs/site-family.md): every site under one registrable
 * domain, over https, written `https://*.bitblocks.network`. One Allow can
 * cover a family; what it may do is less than a site's own grant (SF5).
 *
 * This file holds the parts that need no Public Suffix List: reading a family
 * as it is kept or sent, and whether a site is in one. Which family a site
 * belongs to is publicSuffix.ts's question, asked only where a family is
 * offered and accepted (the sign-in window and the embedded signer).
 */
import { isPublicRelayHost } from "./takeBack.js";

export const FAMILY_PREFIX = "https://*.";

/**
 * Families BitLogin knows, by domain: a grant for one is kept thirty days, as
 * for a site it knows, and for any other family seven. It decides that and
 * nothing else: any domain may be a family (SF9.1). An entry here assumes
 * every name under the domain is run by the same owner (SF9.3); if a world
 * run by someone else is ever hosted under one, its entry is reviewed in the
 * same release. Changed only by a reviewed release.
 */
export const KNOWN_FAMILIES: readonly string[] = ["bitblocks.network"];

/** A family as it may be kept or sent: exactly `https://*.` and a public name in lower case. "" for anything else. */
export function readFamily(input: unknown): string {
  if (typeof input !== "string" || input.length > 260 || !input.startsWith(FAMILY_PREFIX)) return "";
  const domain = input.slice(FAMILY_PREFIX.length);
  if (domain !== domain.toLowerCase() || domain.endsWith(".") || !isPublicRelayHost(domain)) return "";
  return input;
}

/** The domain a family is of, or "". */
export const familyDomain = (family: string): string => (readFamily(family) ? family.slice(FAMILY_PREFIX.length) : "");

/** Whether a site (an exact origin) is in a family: https, no port of its own, and its name is the domain or ends with "." and the domain. */
export function inFamily(site: unknown, family: string): boolean {
  const domain = familyDomain(family);
  if (!domain || typeof site !== "string") return false;
  try {
    const u = new URL(site);
    // A public name: so never a family's own spelling ("*" is no label), an IP, or a private name.
    if (u.protocol !== "https:" || u.port || u.origin !== site || !isPublicRelayHost(u.hostname)) return false;
    return u.hostname === domain || u.hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export const knownFamily = (family: string): boolean => KNOWN_FAMILIES.includes(familyDomain(family));
