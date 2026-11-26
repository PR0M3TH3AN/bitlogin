# When some relays don't answer: never "no account"

**Date:** 2026-11-26. **Status:** built. It mends the "record not found" fault, and the rule is the orchestrator's,
with names given.

## The fault

Sign-in and recovery read an account's capsule from every listed relay and took a quorum (half, rounded up) of
answers as enough. Where the relays holding the account were slow, and a quorum of empty relays answered in time,
the read had its quorum and no record, and said "Account not found" (`no-matching-event`). A scratch test reproduced
it every time: 7 relays, 3 holders answering after the timeout. In the test suites, the stand-in relays run in the
test's own process, so a busy gate made holders late, and the free-check e2e failed three times on one day.

In the widget, a false "not found" did worse than mislead:

- **A passkey sign-in** went on to "make a new account" (passkey-create).
- **A recovery** went on to the rebuild from the phrase.

A sign-up errs the other way, so its free check already held to the opposite rule (`freeAddress.ts`, a40e4ed).

## The rule

`readAccountCarefully` (capsuleReader.ts), used by password and passkey sign-in, and by recovery from the phrase:

1. Every listed relay is read. Any record that decrypts: done.
2. No record, and some relays connected but didn't finish ("slow"): those alone are asked once more, given 5 seconds.
   A record now: done.
3. Still nothing:
   - a relay that connected still hasn't finished → `RelaysSlowError`, `reason: "slow"`: "Some of your relays didn't
     answer in time, so your account couldn't be read. Try again."
   - otherwise, where some listed relays couldn't be reached at all → `RelaysSlowError`, `reason: "unreached"`:
     "Your account wasn't on the relays that answered, but {n} of your relays couldn't be reached. Try again."
4. "Not found" (`no-matching-event`) only where **every** listed relay was reached and answered empty.

Records found but none decrypting (`no-valid-candidate`) is as before. A recovery with an offline export file weighs
that file as before.

## In the widget

The "Your relays didn't all answer" screen shows the words and **Try again**, which repeats the same sign-in or
recovery (a passkey's without a new ceremony). On the passkey path, "Make a new account anyway" is offered as a
second, plainly worded press, and on recovery "Rebuild from your phrase anyway": never as the automatic next screen.
A password sign-in has Try again alone.

**The cost, accepted:** where a built-in relay is down for good, a truly new person's first passkey sign-in reaches
this screen, and needs the one extra press, "Make a new account anyway".

## Tests

- core `slowRelays.e2e.test.ts`:
  - 3 slow holders signed in on the second ask;
  - every relay reached and empty is not found;
  - holders connected and silent is `slow`;
  - holders refusing is `unreached` (3);
  - recovery with unreached holders is `unreached`, then recovers once they're back.
- `account.e2e`: a recovery with every relay unreachable and no export file now fails as `unreached`, no longer as
  "not found".
- widget `relaysSlow.test.ts`: every path takes the error to Try again first, and the second presses.
- Chromium: a password sign-in with both holders unreachable shows the words and Try again with no second press, then
  signs in on Try again.
