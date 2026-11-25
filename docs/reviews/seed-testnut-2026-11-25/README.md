# The seed line against a public test mint (2026-11-25)

Seed review 4's runs against **testnut.cashu.space** (cdk-mintd 0.18.1). The orchestrator agreed the conditions: that
test mint only, its fake sats only, a throwaway account and seed, and stand-in relays held in memory. Nothing was
written to any real relay, and no other mint was asked anything. The scripts are kept as `.txt` so no test run picks
them up; each printed only what happened, never a key, a secret or a proof.

## Run 1, on 14237ee: the wallet as it ships (`run-1-wallet.test.ts.txt`, `output-1-wallet.txt`)

- 8 fake sats funded and claimed, relay-kept.
- **The trial: not tried.** The mint lists NUT-09 and NUT-12 but not NUT-13, which the wallet then required. NUT-13 is
  the wallet's own, so that was mended in 7230657 (`docs/ecash-seed-counter.md`, "What it says of itself").
- The mint's sat keyset also charges `input_fee_ppk` 100.

## Run 2, on 7230657: the seed pieces, called directly (`run-2-seed.test.ts.txt`, `output-2-seed.txt`)

**The trial gate is bypassed in this script.** At this mint the wallet's trial answers "not tried (fees)", and the
wallet would stay relay-kept here. To meet a real mint anyway, the script calls the shipped pieces directly
(`createSeededMint`, `restoreFromMint`, and the stand-in worker over the shipped worker code), as the wallet calls them
after a passed trial. Nothing in the product was changed.

1. **The trial** (shipped `tryMint`): `not-tried`, "This mint charges for each swap, so it can't be tried for one
   sat.", at cost 0. The 1-sat proof stayed unspent.
2. **A seeded add of 21** (shipped `createSeededMint`): 3 proofs, 21 sats, lane 3, 3 counters used. All 3 signatures
   carried a DLEQ proof, checked in the worker, and all 3 proofs are unspent at the mint.
3. **Rule 5.** An output at a counter the mint had signed, offered again for a new paid quote, was refused whole: the
   quote stayed PAID. The same quote with an output nobody had signed was then signed, and the quote became ISSUED. So
   the mint refused the output, not the quote. The mint's restore also said the first counter was signed (the check
   before use, which runs first).
   - **Finding:** cdk words this refusal as code 20006, "Invoice already paid or pending". The add's retry looks for
     "already signed" or code 10002, so at this mint a clash that got past the check before use would end the add with
     an error instead of moving the lane on. The invoice would stay claimable, since the quote stays PAID. That is for
     the orchestrator.
4. **Restore from the key on a fresh device** (shipped `restoreFromMint`; new storage, the same seed, no wallet record,
   no relay): 3 proofs, 21 sats, the same proofs as added, none skipped. 3,503 blinded messages were asked about, and
   all 3 signatures carried a DLEQ proof.
