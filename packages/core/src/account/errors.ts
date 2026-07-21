/** Error types for account flows. Public-facing messages follow §16.3's disclosure rule. */

/** Public message must not disclose whether the locator exists, whether a login name is taken, or why decryption failed (§16.3). */
export class AccountNotFoundError extends Error {
  readonly reason: "quorum-not-met" | "no-matching-event" | "no-valid-candidate";

  constructor(reason: "quorum-not-met" | "no-matching-event" | "no-valid-candidate") {
    super("Account not found or credentials incorrect.");
    this.name = "AccountNotFoundError";
    this.reason = reason;
  }
}

export class RegistrationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationFailedError";
  }
}

/**
 * Thrown when a credential capsule already exists at the address a registration or
 * password change is about to publish to (§15.6, §18.1). That address is a NIP-33
 * replaceable event fully determined by login name + password (or, for a rotation,
 * login name + the chosen new password) -- publishing over one that already exists
 * there would silently destroy whatever account is already bound to it, with no way
 * back short of that other account's own recovery phrase. Unlike {@link AccountNotFoundError},
 * this is not subject to §16.3's login/no-account non-disclosure rule: reaching this
 * error already requires supplying the exact login name + password an existing account
 * was registered with, which is equivalent to already being able to log in as it.
 */
export class AccountAlreadyExistsError extends Error {
  constructor(message = "An account already exists with this login name and password. Sign in instead, or choose different credentials.") {
    super(message);
    this.name = "AccountAlreadyExistsError";
  }
}

export class RecoveryFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryFailedError";
  }
}

/**
 * Thrown instead of a passive warning when a capsule's generation is lower than
 * this device's local high-water mark (§16.2 step 6). A relay-based system cannot
 * guarantee deletion of an old capsule, so an old (rotated-away) password may still
 * decrypt a stale replica on a relay that never processed the tombstone. On a device
 * that has already observed the newer generation, this is the one case the client
 * *can* enforce -- so it fails closed by default instead of silently granting a
 * session. Callers that are confident this is relay lag rather than a stale/old
 * credential (not a distinction the client can make on its own) may pass
 * `acknowledgeRollback: true` to proceed anyway.
 */
export class RollbackDetectedError extends Error {
  readonly seenGeneration: number;
  readonly capsuleGeneration: number;

  constructor(seenGeneration: number, capsuleGeneration: number) {
    super(
      `This credential capsule reports generation ${capsuleGeneration}, but this device has already seen generation ${seenGeneration}. Refusing to log in with older, possibly-revoked credentials.`
    );
    this.name = "RollbackDetectedError";
    this.seenGeneration = seenGeneration;
    this.capsuleGeneration = capsuleGeneration;
  }
}
