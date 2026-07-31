import type { VaultListResult } from "../worker/protocol.js";

/** User-facing summaries for every completeness signal returned by the vault. */
export function buildVaultIntegrityWarnings(result: VaultListResult): string[] {
  const warnings: string[] = [];
  if (result.rollbackWarnings.length > 0) {
    warnings.push(
      `${result.rollbackWarnings.length} wallet record${result.rollbackWarnings.length === 1 ? " was" : "s were"} withheld because relays served an older version than this device previously accepted.`,
    );
  }
  if (!result.quorumMet) {
    warnings.push(
      "Not enough vault relays answered. This connection list may be incomplete.",
    );
  }
  if (result.truncated) {
    warnings.push(
      "A relay returned the maximum record page. Some wallet connections may be missing.",
    );
  }
  if (result.unreadable.length > 0) {
    warnings.push(
      `${result.unreadable.length} encrypted wallet record${result.unreadable.length === 1 ? " was" : "s were"} unreadable and omitted.`,
    );
  }
  return warnings;
}
