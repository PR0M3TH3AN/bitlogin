/**
 * Whether a login name and password's address is free (freeAddress.ts, 2026-11-25), against relays shaped as the live
 * vault list is: some never connect, some answer slowly, one refuses the capsule's kind, the rest answer. A record found
 * anywhere means taken; "free" needs a quorum to answer "nothing here" and no relay that connected left unfinished;
 * and the new capsule is written only where it answered. Replica repair never re-sends a capsule over another record.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { MockRelay, clearRelayTrace, dumpRelayTrace } from "../test-support/mockRelay.js";
import { registerAccount } from "./create.js";
import { changePassword } from "./changePassword.js";
import { loginWithPassword } from "./login.js";
import { completeRecoveryWithNewCredentials, recoverWithPhrase } from "./recover.js";
import { rebroadcastCapsules } from "./repair.js";
import { generatePassphrase } from "./passphrase.js";
import { AccountAlreadyExistsError } from "./errors.js";
import { KIND_APP_DATA } from "../nostr/kinds.js";

const ARGON2_TIMEOUT = 90_000;
/** Short, so a relay that never finishes costs seconds: the first ask. The slow ones answer after it, within the second. */
const QUICK = 1500;
const SLOW_ANSWER_MS = 3000;

describe("an account address is free only when the relays that could hold one say so", () => {
  let relays: MockRelay[] = [];
  let urls: string[] = [];
  /** The live list's shape: [0, 1] never connect; [2] connects and answers slowly; [3] refuses the capsule's kind; [4..7] answer. */
  const liveShape = () => {
    relays[0]!.refuseConnections = true;
    relays[1]!.refuseConnections = true;
    relays[2]!.eoseDelayMs = SLOW_ANSWER_MS;
    relays[3]!.requireAuthForKinds.add(KIND_APP_DATA);
  };
  const plain = () =>
    relays.forEach((r) => {
      r.refuseConnections = false;
      r.eoseDelayMs = 0;
      r.suppressEose = false;
      r.requireAuthForKinds.clear();
    });
  const holds = (r: MockRelay) => r.storedEventKinds().filter((k) => k === KIND_APP_DATA).length;

  beforeEach(async (ctx) => {
    // TEMPORARY trace (2026-11-25): what the relays saw, written out only if this test fails.
    clearRelayTrace();
    onTestFailed(() => dumpRelayTrace(ctx.task.name));
    relays = await Promise.all(Array.from({ length: 8 }, () => MockRelay.start()));
    urls = relays.map((r) => r.url);
  });
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it(
    "registers against the live list's shape, and writes only where it was answered",
    async () => {
      liveShape();
      const made = await registerAccount({ loginName: "live-shape", password: generatePassphrase().secret, vaultRelayUrls: urls, timeoutMs: QUICK });
      expect(made.everydayPublicKey).toMatch(/^[0-9a-f]{64}$/u);
      // Not on the two that never connected; on the slow one and the four that answered; the one refusing the kind took nothing.
      expect([holds(relays[0]!), holds(relays[1]!)]).toEqual([0, 0]);
      expect(holds(relays[3]!)).toBe(0);
      for (const i of [2, 4, 5, 6, 7]) expect(holds(relays[i]!), `relay ${i}`).toBeGreaterThan(0);
    },
    ARGON2_TIMEOUT
  );

  it(
    "refuses where the slow relay holds an account the others don't: found when it is asked again",
    async () => {
      const loginName = "slow-holder";
      const password = generatePassphrase().secret;
      const first = await registerAccount({ loginName, password, vaultRelayUrls: urls });
      for (const i of [0, 1, 3, 4, 5, 6, 7]) relays[i]!.wipeAllData();
      liveShape();
      await expect(registerAccount({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toBeInstanceOf(AccountAlreadyExistsError);
      plain();
      expect((await loginWithPassword({ loginName, password, vaultRelayUrls: [urls[2]!] })).everydayPublicKey).toBe(first.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );

  it(
    "says it couldn't check where a relay that connected never finishes, and writes nothing",
    async () => {
      const loginName = "silent-holder";
      const password = generatePassphrase().secret;
      const first = await registerAccount({ loginName, password, vaultRelayUrls: urls });
      for (const i of [0, 1, 3, 4, 5, 6, 7]) relays[i]!.wipeAllData();
      liveShape();
      relays[2]!.suppressEose = true;
      await expect(registerAccount({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toThrow(/Couldn't check .*connected didn't finish answering/u);
      for (const i of [4, 5, 6, 7]) expect(holds(relays[i]!), `relay ${i}`).toBe(0);
      plain();
      expect((await loginWithPassword({ loginName, password, vaultRelayUrls: [urls[2]!] })).everydayPublicKey).toBe(first.everydayPublicKey);
    },
    ARGON2_TIMEOUT * 2
  );

  it(
    "registers where the only relay holding an account is down, writes nothing there, and repair never writes over it",
    async () => {
      const loginName = "down-holder";
      const password = generatePassphrase().secret;
      const older = await registerAccount({ loginName, password, vaultRelayUrls: urls });
      for (let i = 1; i < 8; i++) relays[i]!.wipeAllData();
      // The one that holds it is down; seven answer, with nothing.
      relays[0]!.refuseConnections = true;
      const newer = await registerAccount({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK });
      expect(newer.everydayPublicKey).not.toBe(older.everydayPublicKey);
      // It comes back: the newer account's sign-in repairs replicas, and holds back from the relay with the older one.
      relays[0]!.refuseConnections = false;
      const login = await loginWithPassword({ loginName, password, vaultRelayUrls: urls.slice(1) });
      const repair = await rebroadcastCapsules({ relayUrls: urls, credentialEvent: login.credentialEvent, recoveryEvent: login.recoveryCapsuleEvent, timeoutMs: QUICK });
      const there = repair.relays.find((r) => r.relayUrl === urls[0])!;
      expect(there.credential).toMatchObject({ ok: false });
      expect(there.credential.message).toMatch(/held back: it holds another record/u);
      // The older account is still whole there.
      expect((await loginWithPassword({ loginName, password, vaultRelayUrls: [urls[0]!] })).everydayPublicKey).toBe(older.everydayPublicKey);
    },
    ARGON2_TIMEOUT * 2
  );

  it(
    "says it couldn't check where too few relays answer",
    async () => {
      for (const i of [0, 1, 2, 3, 4]) relays[i]!.refuseConnections = true;
      await expect(registerAccount({ loginName: "too-few", password: generatePassphrase().secret, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toThrow(/too few vault relays answered/u);
    },
    ARGON2_TIMEOUT
  );

  it(
    "refuses a password change onto an address another account holds on the slow relay",
    async () => {
      const loginName = "shared-name";
      const takenPassword = generatePassphrase().secret;
      const other = await registerAccount({ loginName, password: takenPassword, vaultRelayUrls: urls });
      const mine = generatePassphrase().secret;
      await registerAccount({ loginName, password: mine, vaultRelayUrls: urls });
      // The other account only on the slow relay now; mine on all the others.
      const otherOnly = relays[2]!;
      for (const r of relays) if (r !== otherOnly) r.wipeAllData();
      await registerAccount({ loginName, password: mine, vaultRelayUrls: urls.filter((u) => u !== otherOnly.url) }).catch(() => {});
      otherOnly.eoseDelayMs = SLOW_ANSWER_MS;
      await expect(changePassword({ loginName, oldPassword: mine, newPassword: takenPassword, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toBeInstanceOf(AccountAlreadyExistsError);
      plain();
      expect((await loginWithPassword({ loginName, password: takenPassword, vaultRelayUrls: [otherOnly.url] })).everydayPublicKey).toBe(other.everydayPublicKey);
    },
    ARGON2_TIMEOUT * 2
  );

  it(
    "refuses a recovery onto a login name and password another account holds on the slow relay",
    async () => {
      const takenName = "taken-at-recovery";
      const takenPassword = generatePassphrase().secret;
      const other = await registerAccount({ loginName: takenName, password: takenPassword, vaultRelayUrls: urls });
      const mine = await registerAccount({ loginName: "mine-recovering", password: generatePassphrase().secret, vaultRelayUrls: urls });
      const recovered = await recoverWithPhrase({ phrase: mine.recoveryPhrase, vaultRelayUrls: urls, discoveryRelayUrls: [] });
      for (const i of [0, 1, 3, 4, 5, 6, 7]) relays[i]!.wipeAllData();
      relays[2]!.eoseDelayMs = SLOW_ANSWER_MS;
      await expect(completeRecoveryWithNewCredentials({ recovered, newLoginName: takenName, newPassword: takenPassword, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toThrow(/already registered/u);
      plain();
      expect((await loginWithPassword({ loginName: takenName, password: takenPassword, vaultRelayUrls: [urls[2]!] })).everydayPublicKey).toBe(other.everydayPublicKey);
    },
    ARGON2_TIMEOUT * 2
  );
});
