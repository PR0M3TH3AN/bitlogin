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

export class RecoveryFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryFailedError";
  }
}
