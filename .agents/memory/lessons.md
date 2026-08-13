# Lessons

Hard-won lessons and recurring landmines.

## Security regressions must fail closed, not warn

An external integration pass found an account-takeover-adjacent gap: the
password-rotation tombstone (§18.1) is only advisory, so a relay that never
processes it can serve the pre-rotation capsule forever — and the client
accepted that stale capsule with a non-blocking warning while still granting
the session. The fix makes generation-rollback detection fail closed by
default (`RollbackDetectedError` on login and password change), with an
explicit `acknowledgeRollback` override for the narrow non-adversarial
lagging-relay case. Residual weakness, by design limits: a brand-new device
with no local generation high-water mark has only the quorum defense. The
general lesson: on this codebase, a detected security-relevant regression
gets a refusal, not a warning string.

Authoritative source:
- docs/spec.md "Changes from v0.3" item 1, §16.2 step 6, §29.7
- SECURITY.md "Status" section
