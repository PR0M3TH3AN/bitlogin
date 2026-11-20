/**
 * Reading a file that "Export identity" made, to bring an account back with
 * it.
 *
 * There are two, and they are different things:
 *
 *   - The recovery export (`bitlogin-recovery-export.json`): the account's
 *     own sealed records, as relays hold them. It carries no key that can be
 *     read without the recovery phrase, so it is safe to store anywhere and
 *     useless alone. With the phrase it restores the whole account, saved
 *     wallet connections included, even when no relay holds it any more.
 *   - The key file (`bitlogin-private-key.txt`): the identity's private key,
 *     in the clear. It is the identity itself and nothing else of the
 *     account: with it a new account is made around the same identity.
 *
 * This only reads a file and says which it is. Nothing here uses a key.
 */
import { parseRecoveryExport, type RecoveryExportFile } from "@bitlogin/core/account";

export const RESTORE_FILE_LIMITS = {
  /** A file larger than this is not read. An export is a few kilobytes. */
  bytes: 2_000_000
} as const;

export type RestoreFile =
  | { kind: "recovery-export"; file: RecoveryExportFile }
  | { kind: "key"; key: string }
  | { kind: "unknown"; why: string };

/** bech32's own alphabet, after "nsec1": so a key is never cut short or run on into the text beside it. */
const NSEC = /nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}(?![023456789acdefghjklmnpqrstuvwxyz])/gu;

export function readRestoreFile(text: unknown): RestoreFile {
  if (typeof text !== "string" || text.length === 0) return { kind: "unknown", why: "The file is empty." };
  if (text.length > RESTORE_FILE_LIMITS.bytes) return { kind: "unknown", why: "The file is too large to be a BitLogin export." };
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return { kind: "recovery-export", file: parseRecoveryExport(JSON.parse(trimmed)) };
    } catch (err) {
      return { kind: "unknown", why: `It looks like a recovery export, but it can't be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const keys = [...new Set(trimmed.match(NSEC) ?? [])];
  if (keys.length === 1) return { kind: "key", key: keys[0]! };
  if (keys.length > 1) return { kind: "unknown", why: "The file holds more than one private key. Paste the one you mean under \"Import a Nostr key\"." };
  return { kind: "unknown", why: "This is not a file BitLogin's \"Export identity\" made: it holds neither a recovery export nor a private key." };
}
