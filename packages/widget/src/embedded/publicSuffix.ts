/**
 * Which family a site belongs to (docs/site-family.md SF3), by the Public
 * Suffix List: the registrable domain of its name, over https.
 *
 * The list is shipped (publicSuffixList.ts, made by
 * scripts/update-public-suffix.mjs) and changed only by a reviewed release.
 * A browser keeps the embedded signer's storage apart by the same idea, from
 * its own copy, so a family worked out wrongly here is still never seen by a
 * page of another site where a browser partitions storage. The rule here is
 * meant to be right without that.
 */
import { FAMILY_PREFIX } from "./family.js";
import { PUBLIC_SUFFIX_ICANN, PUBLIC_SUFFIX_PRIVATE } from "./publicSuffixList.js";
import { isPublicRelayHost } from "./takeBack.js";

/** Each rule, and whether it is from the list's private section (a service handing out names to others). */
let rules: Map<string, boolean> | null = null;
const theRules = (): Map<string, boolean> => {
  if (rules) return rules;
  rules = new Map();
  for (const rule of PUBLIC_SUFFIX_ICANN.split("\n")) rules.set(rule, false);
  for (const rule of PUBLIC_SUFFIX_PRIVATE.split("\n")) rules.set(rule, true);
  return rules;
};

/**
 * The public suffix of a name, by the list's own algorithm: the longest rule
 * that matches, an exception rule taking one label off, and "*" (the last
 * label) where nothing does. `labels` is how many labels it is.
 */
export function publicSuffixOf(hostname: string): { labels: number; isPrivate: boolean } {
  const all = theRules();
  const labels = hostname.toLowerCase().split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (all.has(`!${candidate}`)) return { labels: labels.length - i - 1, isPrivate: all.get(`!${candidate}`)! };
    if (all.has(candidate)) return { labels: labels.length - i, isPrivate: all.get(candidate)! };
    const rest = labels.slice(i + 1).join(".");
    if (rest && all.has(`*.${rest}`)) return { labels: labels.length - i, isPrivate: all.get(`*.${rest}`)! };
  }
  return { labels: 1, isPrivate: false };
}

/** The registrable domain of a name: its public suffix and one label more. "" where the name is itself a public suffix. */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split(".");
  const { labels: suffix } = publicSuffixOf(hostname);
  return labels.length > suffix ? labels.slice(labels.length - suffix - 1).join(".") : "";
}

/**
 * The family a site may be offered, as `https://*.domain`, or "" where none
 * is (SF3): not https, a port of its own, an address that is no public name
 * (an IP, localhost, a private name), a name that is itself a public suffix,
 * or a name under a suffix from the list's private section, where each name
 * is someone else's (`alice.github.io`, `x.vercel.app`).
 */
export function familyOf(site: unknown): string {
  if (typeof site !== "string" || site.length > 300) return "";
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" || u.port || u.origin !== site || !isPublicRelayHost(u.hostname)) return "";
  if (publicSuffixOf(u.hostname).isPrivate) return "";
  const domain = registrableDomain(u.hostname);
  return domain ? FAMILY_PREFIX + domain : "";
}
