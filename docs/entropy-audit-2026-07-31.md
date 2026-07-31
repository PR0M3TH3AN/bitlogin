# BitLogin — randomness and RNG-integration audit, 2026-07-31

Audit of every security-sensitive random value in `packages/`, against a
Coldcard-class checklist: where each bit of unpredictability originates, whether
that source is present in the production build, and what happens when it fails.

## Verdict

**No predictable-fallback defect exists.** `packages/core/src/crypto/random.ts`
is the single chokepoint for every secret this codebase mints, and it is correct:

- It throws when `crypto.getRandomValues` is unavailable rather than falling
  back to anything (`random.ts:5-9`). There is no second code path.
- `randomUniformInt` (`random.ts:36-49`) uses **rejection sampling**, so
  wordlist and charset selection carry no modulo bias.
- `generatePrivateKey` (`crypto/secp256k1.ts:16-21`) rejection-samples until the
  scalar is in range rather than clamping or reducing.
- Nothing seeds a CSPRNG manually; nothing uses timestamps, PIDs, device IDs or
  counters as entropy.
- Crypto dependencies are exact-pinned, not caret-ranged (`@noble/curves`
  1.9.7, `@noble/hashes` 1.8.0, `@scure/bip39` 1.6.0, `@scure/base` 1.2.6), and
  CI emits a CycloneDX SBOM plus per-artifact SHA256SUMS.

Entropy accounting is sound: 128 bits into a 12-word BIP-39 phrase
(`randomEntropy128`), 256-bit connection-vault root and sudo key, 128-bit
account id, ~77 bits for the default six-word EFF passphrase with a hard floor
at 64 bits (`account/passphrase.ts:28-30`). No source is truncated before use,
and no transformation is treated as creating entropy.

The work below is hardening, not repair.

---

## Open items

### M1 — Nonce-injection hooks are reachable from the shipped public API

`nip44Encrypt` and `nip04Encrypt` accept caller-supplied nonces:

```ts
// packages/core/src/crypto/nip44.ts:124
export function nip44Encrypt(conversationKey: Uint8Array, plaintext: string, nonceOverride?: Uint8Array): string {
  const nonce = nonceOverride ?? randomBytes(32);

// packages/core/src/crypto/nip04.ts:24
  ivOverride?: Uint8Array
): string {
  const iv = ivOverride ?? randomBytes(16);
```

These exist for a legitimate reason — the official NIP-44 v2 test vectors pin
the nonce, and `crypto.test.ts` cannot verify against them otherwise. No
production caller passes either parameter; the only other references are the
generated `.d.ts` declarations.

The problem is the surface, not the current callers. Both functions are exported
from `@bitlogin/core/crypto`, so the override is part of what this package
advertises. Nonce reuse in NIP-44 (ChaCha20) and NIP-04 (AES-CBC) is not a
gradual weakening — it is immediate plaintext recovery, and for CBC a repeated
IV leaks the first block relationship directly. A parameter that silently
accepts a fixed nonce should not be one autocomplete away from application code.

**Fix.** Keep the vectors working, remove the footgun:

1. Rename the parameterised forms to `__unsafeNip44EncryptWithNonce` /
   `__unsafeNip04EncryptWithIv` and move them into a `crypto/testing.ts` module
   that is **not** listed in the `exports` map of `packages/core/package.json`.
2. Leave `nip44Encrypt` / `nip04Encrypt` with two- and three-argument
   signatures that always call `randomBytes`.
3. Point `crypto.test.ts` and `knownAnswer.test.ts` at the new module via a
   relative import.

**Acceptance.** `crypto.test.ts` still passes the official NIP-44 vectors;
`import { nip44Encrypt } from "@bitlogin/core/crypto"` exposes no nonce
parameter in its type signature; `npm run security:ci` is green.

**Care required.** This touches the derivation chain's neighbourhood but not the
chain itself — no capsule bytes change. `knownAnswer.test.ts` must stay green
without its expected values being edited. If it goes red, stop: per the standing
rule in `TODO.md`, that means the change is account-breaking.

---

### M2 — Nothing tests that the RNG fails closed

This is the gap the whole exercise turns on. The crypto suite is genuinely good
— known-answer coverage for HKDF, ScalarExpand, the Argon2id profile, BIP-39
phrase and seed, Schnorr, AES-GCM tamper-detection, JCS ordering, padding
buckets. **None of it asserts what happens when randomness is unavailable.**

`random.ts:5-9` is correct today. Nothing in CI would report it if a future
refactor made it return zeros, or added an `?? fallback`, or moved the guard
behind a condition that no longer fires. A deterministic stream passes every
self-consistency test in the suite.

**Fix.** Add to `packages/core/src/crypto/crypto.test.ts`:

```ts
describe("RNG fails closed (§11.1)", () => {
  it("throws when no secure random source exists", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      expect(() => randomBytes(32)).toThrow(/no cryptographically secure/i);
      expect(() => randomEntropy128()).toThrow();
      expect(() => generatePrivateKey()).toThrow();
    } finally {
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
    }
  });

  it("throws when crypto exists but getRandomValues does not", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
      expect(() => randomBytes(32)).toThrow(/no cryptographically secure/i);
    } finally {
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
    }
  });
});
```

Add a companion uniformity test proving the rejection loop actually rejects —
without it, `randomUniformInt` could degrade to `value % maxExclusive` and stay
green:

```ts
it("randomUniformInt is unbiased across a modulus that does not divide 256", () => {
  const M = 94, N = 200_000;
  const counts = new Array(M).fill(0);
  for (let i = 0; i < N; i++) counts[randomUniformInt(M)]++;
  const expected = N / M;
  const chi2 = counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
  expect(chi2).toBeLessThan(160); // df=93, p<0.001 critical value ~147
});
```

**Acceptance.** Both tests pass on `main`. Deliberately breaking `random.ts`
(returning a zero-filled array, or swapping the rejection loop for a bare
modulo) must turn them red — verify this locally before committing, then revert.

---

### L1 — `Math.random` in the backup-verification quiz

`packages/widget/src/element.ts:1471`:

```ts
function pickRandomIndices(max: number, count: number): number[] {
  ...
  const idx = Math.floor(Math.random() * pool.length);
```

Called once, at `element.ts:857`, to choose which three recovery-phrase words to
ask the user to re-type after registration. **This is not a secret and leaks no
entropy** — the phrase itself comes from `randomEntropy128`, and an attacker who
cannot see the phrase gains nothing from predicting which words get quizzed.

It is worth changing anyway, for a process reason. As long as one `Math.random`
call survives in security-adjacent source, a static-analysis rule banning
`Math.random` (checklist §13) needs a standing exception — and standing
exceptions are where the next real one hides.

**Fix.** Import `randomUniformInt` from `@bitlogin/core/crypto` and replace the
`Math.floor(Math.random() * pool.length)` expression. Then add the ban rule to
the semgrep config so the file cannot regress.

**Note.** `src/vendor/bitlogin/bitlogin.js:1696` in the **bitunlock** repo is
this same function, vendored. Fixing it here and re-running
`scripts/build-bitlogin-widget.mjs` there clears both.

---

### L2 — `Math.random` in the relay subscription id

`packages/core/src/nostr/relay.ts:223` mixes `Math.random()` into the material
hashed for a subscription id. A subscription id is a public wire identifier
scoped to one socket; it is not a secret and collision is the only failure mode.
No change needed. Recorded so the next audit does not re-flag it.

---

## Not findings, recorded so they are not re-litigated

- **`params.now` test hook** in `account/create.ts:62` injects a timestamp, not
  entropy. Timestamps are already public in Nostr event envelopes.
- **`@noble` v2 upgrade.** Out of scope here, and blocked for an unrelated
  reason already captured in `TODO.md` — noble v2 dropped the extensionless
  subpath exports this code imports.

## Sequencing

M2 first — it is additive, cannot break the derivation chain, and it is what
protects M1's fix from silently regressing later. Then M1. Then L1, batched
with whatever else next touches `element.ts`.
