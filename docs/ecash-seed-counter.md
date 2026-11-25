# The Wallet's Seed Counter: Its Rules, Before Its Code

**Date:** 2026-11-24 (third draft: agreed, "go" on these rules)
**Status:** Agreed rules. The owner ordered it built ("yes": the small fix
first, then restore from the mint). Built on beta, against mock mints only,
through step 3 (2026-11-25): the wallet adds by the seed at a mint whose
keyset passed the trial (`ecash/wallet.ts`), and its screen names each
mint, offers the trial at a press, and restores from the mints
(`assets/ecash-ui.js`). Not yet on any site.

## What it is, and what a counter used twice costs

With a seed (Cashu NUT-13), every output the wallet asks a mint to sign
is made from three things: the seed, the mint's keyset, and a
**counter**, one per output. The mint can later hand back what it still
owes, from the same seed and counters (NUT-09 restore). So the account's
key alone is enough to get the sats back, with no relay at all.

**A counter used twice loses money, if the mint signs it twice.** The
second set of outputs is the same as the first, so the proofs that come
back are proofs the wallet already holds. Whatever the mint took for the
second operation is gone:

- **Adding sats:** the whole amount of the paid invoice, for example
  1,000 sats for a 1,000-sat invoice.
- **A payment:** the change, up to the whole fee reserve.
- **A swap** (receiving a token, splitting): the whole value swapped.

A mint that **refuses** outputs it has signed before loses nothing. It
refuses the whole request and keeps nothing; a paid invoice can be
claimed again with new outputs.

## The rules

### 1. Write the counter down before using it, and take only what is needed

The wallet takes exactly as many counters as the operation needs (one per
output, at most a few dozen), seals the new value in this browser, and
only then asks the mint. There are no blocks: lanes keep two browsers
apart (rule 3). A crash after the write burns that operation's counters,
and nothing more.

**The largest gap a lane can have** is the counters burned by crashes in a
row with nothing signed between them: a few dozen per crash. A run of 300
unsigned counters, the library's default for restore, would take about
ten crashes in a row. Restore is set against that, in rule 3.

### 2. The counter only goes up

The value used is the highest one seen, from this browser, any relay, or
a restore, and nothing ever sets it lower. In `@cashu/cashu-ts` this is
its own counter interface: `reserve`, and a monotonic
`advanceToAtLeast`.

### 3. Each browser keeps to a lane of its own: safety needs no relay

Today's finding is that the owner's own relays read but never confirm a
write. On such relays, browser B never learns what browser A reserved.
Both would go on from the same number, and the first time both were used
they would clash for certain. Blocks don't help: both would take the same
block. So keeping two browsers apart must not depend on relays at all.

- **The counter space is split into 32 lanes.** Lane *k* is the counters
  from *k* × 2²⁶ up to (*k* + 1) × 2²⁶ − 1, about 67 million each. That
  stays below 2³¹, because the older keysets use the counter as a
  hardened BIP32 index.
- **A browser draws its lane at random on first use, and keeps it in
  this browser only.** It counts up within that lane alone. Nothing about
  the lane is taken from a relay or another device.
- **The lane drawn must be one the mint says is empty.** On first use
  with a mint, the wallet asks it (restore) whether the lane's first
  counters hold anything it has signed. If they do, another browser of
  this account has that lane, or this one did before it was cleared, and
  the wallet draws again. Two browsers then share a lane only if both
  draw the same empty one before either has used it. That is far rarer
  than 1 in 32, and even then rules 4 and 5 protect them.
- **A cleared browser never goes back to its old lane.** It draws anew,
  and the mint shows the old lane as used, so it isn't drawn again. The
  sats in the old lane are still found by restore, which looks in every
  lane.
- **The relay copy only speeds a new device up.** It records the highest
  counter used in each lane, so a restore needn't search from 0. It is
  never what safety rests on.
- **How far restore looks in each lane, set against the largest gap
  (rule 1):**
  - **A lane where nothing is found** in its first 100 counters is empty.
    It stops there.
  - **A lane where something is found** is followed past the last signed
    counter by 300 more, the library's own gap: about ten crashes in a
    row with nothing signed between, well beyond what rule 1 leaves.
  - **Where the relay copy names a highest counter for the lane,** restore
    goes at least that far, whatever gaps it meets on the way.
- **What a wider gap costs, said plainly on the screen:** "If a crash left
  a long gap in a lane and BitLogin's record of the counter is gone from
  every relay too, restore can miss what came after the gap. Those sats
  are still at the mint, but this wallet can't find them." (Tested: 5 of
  12 found without the relay copy, all 12 with it.)
- **What that costs:** an empty lane is about 100 outputs asked about, so
  all 32 empty is about 3,200, a few requests to each mint. A lane in use
  costs what it holds, plus 300.

### 3a. Two tabs of one browser share its lane

The panel and a page of bitlogin.network, or two tabs, share this
browser's storage, and so its lane. Every read and change of a lane's
state is made under one lock per mint keyset (`navigator.locks`, which
every tab and worker of the site shares). **Where a browser has no
`navigator.locks`, the seed isn't used in it at all.** A lock within one
page would not stop two tabs. That browser stays relay-kept, as a mint
that hasn't passed the trial does, and the screen says: "This browser
can't keep two tabs from using the same counters, so the seed isn't used
in it. Your sats are kept on relays as before." Every current browser has
`navigator.locks`. Reserving reads the counter, takes what it needs and
writes it back under the lock. Moving forward never writes a counter lower
than the one stored. (Tested: two tabs adding at once, without the lock,
were handed the same counters and lost one set on a signing-again mint.
Under the lock, nothing was lost.)

### 4. A mint is used with the seed only once it is shown to refuse outputs it has signed before

**Until then, it is used as today:** relay-kept, with no seed. The
wallet names it as a mint whose sats can't be restored from the key
alone. How a mint is shown to refuse:

- **What it says of itself (NUT-06):** it must list restore (NUT-09) and
  deterministic secrets (NUT-13). That is needed, but not enough.
- **A trial that can cost one sat** (built in `ecash/mintTrial.ts`,
  2026-11-24). One 1-sat proof of the person's is swapped into an output
  made from a counter kept for trials: the last 4,096 below 2³¹, which no
  lane reaches. The mint is asked first that the counter is unused. The
  proof that comes back is then swapped into that same output again.
  - A mint that charges for each swap isn't tried. The trial would cost
    more than a sat, and nothing is spent.
  - If the mint refuses the second request, it passes.
  - If it signs it again, it fails, and the most this costs is the 1 sat
    (and any fee).
  - **It runs only when the person presses for it.** Words beside the
    button say what it is and that it can cost one sat. It never runs by
    itself when the wallet opens. Until they press, that mint stays
    relay-kept and named.
  - It runs once per mint keyset. The result is kept sealed with the
    wallet record, and asked for again when the keyset changes.
- **No built-in list of mints.** Each wallet finds out for itself, and
  the screen says which of its mints passed.

### 5. Before every use, ask the mint whether the counters are taken

Immediately before an operation, the wallet asks the mint, with NUT-09
restore, whether any of the outputs it is about to use were signed
before. If any were, it moves past them and takes new ones. This catches
two browsers in the same lane, unless both are used within the moment
between the check and the operation. It costs one extra request per
operation.

### 6. A cleared browser, or a new device

It draws a lane (rule 3), takes the highest relay copy for that lane
where one answers, and runs rule 5 before its first use. With every
relay gone, rule 5 and the mint are enough.

### 7. Where the seed comes from

- **The function:** `seed = HKDF-Expand(HKDF-Extract(salt =
  SHA-256("bitlogin/ecash-seed/v1"), ikm = the account's private key),
  info = "nut13", 64 bytes)`, as BitLogin's other keys are made (`labelSalt`,
  `hkdfExtract`, `hkdfExpand` in `@bitlogin/core/crypto`). The label is used
  for nothing else, so the seed can never equal anything else made from that
  key. Built in `worker/ecashSeed.ts` (2026-11-24).
- **Made in the worker.** The account's key never leaves it.
- **The seed never leaves the worker either.** The Cashu library runs on
  the wallet's page, because only that page may reach a mint: every
  worker is held to `connect-src 'self' wss:` (`ecash.md` EC6), and
  letting the key-holding worker reach any https address would loosen
  the one place keys live. So the worker makes the outputs instead.
  - For each operation, the page tells the worker the mint's keyset (its
    public keys), the amounts and the counters reserved.
  - The worker derives each output's secret and blinding factor from the
    seed and hands back those outputs alone.
  - The library takes them as they are (`asCustom`), and restore is
    asked with outputs made the same way.
  - The page sees what any operation's outputs are, as it already sees
    the proofs, and never the seed. A seed makes every future proof, so
    it is held as closely as the key itself.
- **If an account's key ever changes:** BitLogin has no way to change an
  account's key today. If one is ever built, the old seed must be carried
  to the new key, sealed in the wallet record, or every proof swept onto
  the new seed first. Otherwise the old key's proofs could be restored
  only with the old key.

### 8. Sats held before this change

They weren't made from the seed, and restore can't find them. They stay
kept as today. As they are spent, their change comes back seeded, so a
wallet moves onto the seed through use.

## The order of building, and what touches what

1. A mock mint taught to restore, in two versions: one that refuses
   outputs it has signed before, one that signs them again.
2. The worker's seed and output derivation, then the counters and lanes,
   then restore, each with its tests against both mocks.
3. The wallet screen: which mints are seeded, the trial at a press,
   "Restore from your mints".
4. **Nothing of it asks a real mint or moves a real sat from this side,
   ever.** A real mint is first met by the owner, in a released build, at
   his own press.

## What is tested before it is trusted

On a mock mint taught to restore, in two versions: one that refuses
outputs it has signed before, and one that signs them again.

- A counter written before the mint is asked, and a crash in between:
  counters are burned, and nothing is lost.
- A relay holding an older counter never takes it backwards.
- **Two browsers in different lanes, with every relay dead,** each adding
  and spending: nothing is lost, on either mint.
- **Two browsers forced into the same lane:**
  - on the refusing mint, the clash is refused and retried, and nothing
    is lost;
  - on the signing-again mint, with the check before use, used one after
    the other, nothing is lost;
  - used in the same moment, the test shows exactly what is lost: the
    value of one operation's outputs. That is why rule 4 keeps such a
    mint off the seed.
- The trial of rule 4, at a press only: the refusing mint passes it and
  the signing-again mint fails it, at a cost of 1 sat. Opening the wallet
  never runs it.
- Rule 3's draw: a lane the mint shows as used is never drawn; a cleared
  browser draws a new lane.
- Restore after two crashes in a row in one lane still finds what lies
  beyond them.
- The seed never appears in a message from the worker, nor in anything
  stored.
- Restore from the key alone, with every relay emptied, brings back
  exactly what the mint still owes, from every lane.

## Open, for the owner

- Restore asks each mint about a few thousand outputs. The mint learns
  nothing about the person from that (the requests are blinded), but it
  takes a few seconds.
- Other NIP-60 wallets don't use this seed. The same account opened in
  one of them sees the same sats, but can't restore them.
