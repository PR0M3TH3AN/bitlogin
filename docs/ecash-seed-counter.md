# The Wallet's Seed Counter: Its Rules, Before Its Code

**Date:** 2026-11-24
**Status:** A design to be read before anything is built. Ordered by the
owner the same day ("yes": the small fix first, then restore from the
mint). Nothing here exists yet.

## What it is, and why it can lose money

With a seed (Cashu NUT-13), every proof the wallet asks a mint to sign is
made from three things: the seed, the mint's keyset, and a **counter**
that goes up by one for each proof. The mint can later hand back what it
still owes, by the same seed and counters (NUT-09 restore). The seed
comes from the account's own key, so the key alone is enough.

The one way this can lose money is a **counter used twice**. The second
set of proofs would be the same as the first. Whatever the mint gave for
the second operation (sats paid in, change) would then be proofs the
wallet already holds, so worth nothing new. Every rule below exists to
stop that happening.

## The rules

1. **A counter is reserved and written down before it is used.** The
   wallet adds N to the counter for that keyset, seals the new value in
   this browser, and only then asks the mint. A crash after the write
   burns a few counters; a gap is harmless, because restore steps over
   gaps (up to 300 in a row, the library's default).
2. **The counter only ever goes up.** Wherever it is read from (this
   browser, any relay, a restore), the value used is the highest seen.
   Nothing ever sets it lower. `@cashu/cashu-ts` asks for exactly this:
   a counter source with `reserve` and a monotonic `advanceToAtLeast`.
3. **Where it is kept.**
   - In this browser: inside the wallet's sealed copy, written first, as
     every proof already is (`ecash.md` EC2).
   - On relays: in the wallet's own record (kind 17375, sealed to the
     account's key) as one value per keyset, sent after each
     reservation. Not waited for: rule 1 is what keeps money safe, and
     the relay copy is for other devices and for a cleared browser.
4. **A relay returns an older counter.** It is ignored, by rule 2. The
   highest seen wins, from any relay that answered, and it is never
   written back lower.
5. **This browser's storage is cleared, or a new device.** The counter
   is the highest value relays return. Before its first use on such a
   browser, the mint is asked too: restore from 0 tells the last counter
   it ever signed, and the counter goes to at least one past that. So
   even with every relay gone, the mint itself says where to go on from.
6. **Two browsers open at once.** Both can read the same counter and
   reserve the same range before either's write reaches the other. This
   is the real risk, and it is handled twice:
   - **The mint refuses outputs it has already signed.** Standard mints
     refuse a blinded message they have signed before, and refuse the
     whole request without spending anything. The wallet treats that
     refusal as "counter behind": it moves the counter past the clash,
     re-reserves, and tries again. The sats are not lost: a paid
     invoice can be claimed again with new outputs; a swap or a payment
     was refused whole. **This must be checked against each mint before
     it is relied on.** The mock mint will be taught to refuse such
     outputs as standard mints do, and the tests will clash two
     browsers on purpose.
   - **Each browser reserves ahead in blocks** (for example 50 at a
     time), so two open at once rarely touch the same numbers. The gap a
     block leaves is well inside restore's 300.
7. **A mint that cannot restore** (no NUT-09) still works as today,
   relay-kept only. The wallet says, by that mint's name, that its sats
   can't be restored from the key alone.
8. **Proofs held before this change** were not made from the seed, and
   restore cannot find them. They stay kept as today. As they are spent,
   the change comes back seeded, so a wallet moves onto the seed by use.

## What is tested before it is trusted

- A counter written before the mint is asked, and a crash in between,
  burns counters and loses nothing.
- A relay holding an older counter never takes it backwards.
- A cleared browser goes on from the highest of relays and the mint's
  own restore.
- Two browsers reserving at once: the mint refuses the clash, nothing is
  spent, and the retry succeeds.
- Restore from the key alone, with every relay emptied, brings back
  exactly what the mint still owes.

## Open, for the owner

- Restore asks the mint about every counter in a range. A mint learns
  nothing about the person from that (the requests are blinded), but it
  is a few requests per keyset each time it is run.
- Other NIP-60 wallets don't use this seed. The same account opened in
  one of them sees the same sats, but can't restore them.
