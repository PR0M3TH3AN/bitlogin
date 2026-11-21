/** Main-thread proxy for the crypto Web Worker. Every method returns a Promise resolving to public data only. */
import type {
  WorkerActionMap,
  WorkerAction,
  WorkerRequest,
  WorkerResponse,
  ConfigurePayload,
  RegisterPayload,
  PreviewImportKeyPayload,
  LoginPayload,
  RecoverPayload,
  CompleteRecoveryPayload,
  PhraseRebuildPayload,
  ChangePasswordPayload,
  PublishProfilePayload,
  SignEventPayload,
  Nip44EncryptPayload,
  Nip44DecryptPayload,
  Nip04EncryptPayload,
  Nip04DecryptPayload,
  VaultSaveNwcPayload,
  VaultFindForOriginPayload,
  VaultRevealNwcPayload,
  VaultSetBindingPayload,
  VaultDeletePayload,
  VaultOfferCheckPayload,
  Nip46ConnectPayload,
  Nip46NostrconnectStartPayload,
  WorkerNotification,
  HandoffExportPayload,
  HandoffSealed,
  LoadProfilePayload,
  LockDevicePayload,
  LockOpenPayload,
  LockPinPayload,
  RoomPassPayload,
  WorldSavePayload,
  WorldFindPayload,
  WorldOpenPayload,
  WorldFollowPayload,
  WorldScorePayload,
  WorldAchievePayload,
  WorldSealPayload,
  WorldUnwrapPayload,
  WorldReachPayload,
  SignerKeepPayload,
  TakeBackPayload,
  SignerSitePayload,
  AppCryptPayload,
  AppDecryptEventPayload,
  SignerTouchPayload
} from "./protocol.js";

/**
 * How long a single worker call may take before the caller is told, rather
 * than left hanging. Argon2id at 64 MiB plus a relay quorum round trip is the
 * slow case; a minute is far past it and still finite.
 */
const CALL_TIMEOUT_MS = 60_000;

/**
 * NIP-46 calls wait on a HUMAN approving a prompt on another device, on top of
 * relay round trips -- the worker-side deadlines (120s per signer request,
 * 180s for the nostrconnect listen) are the real limits; these exist only so
 * a dead worker still rejects. Kept above the worst worker-side sum so the
 * worker's own, better-worded timeout error is the one callers see.
 */
const NIP46_CALL_TIMEOUT_MS = 260_000;
const NIP46_AWAIT_TIMEOUT_MS = 320_000;

export class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private counter = 0;
  private dead = false;
  /** Why the worker is gone, surfaced on every post-teardown rejection so a
   *  developer sees the CAUSE (usually an unmounted element), not just a bare
   *  failure. Overridable via terminate(reason). */
  private deadReason = "This BitLogin session was torn down; reload the page to sign in again.";
  /** Set by the element to receive unsolicited worker frames (auth_url). */
  onNotification: ((notification: WorkerNotification) => void) | null = null;

  constructor() {
    // Deliberately NOT the literal `new Worker(new URL("./x.js", import.meta.url))` shape: Vite
    // statically pattern-matches that exact expression (string-literal first argument) and
    // rewrites/inlines it at build time, which breaks when this widget is served from a
    // subdirectory rather than the site root. Building the path in a variable defeats the
    // static match, leaving plain runtime URL resolution -- relative to *this* module's actual
    // URL, exactly like any other web platform relative import -- untouched by the bundler.
    const workerFileName = ["cryptoWorker", ".js"].join("");
    const workerUrl = new URL(workerFileName, import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      // Shape-check before trusting: a malformed frame used to throw inside
      // this listener, which posts no response and hangs the caller forever.
      if (!msg || typeof msg !== "object") return;
      // Unsolicited notification frames (no id) -- currently only the NIP-46
      // auth_url, which arrives mid-call and cannot ride a response.
      const maybeNotification = msg as unknown as Partial<WorkerNotification>;
      if (maybeNotification.notify === "nip46-auth-url" && typeof maybeNotification.url === "string") {
        this.onNotification?.(maybeNotification as WorkerNotification);
        return;
      }
      if (typeof (msg as WorkerResponse).id !== "string") return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const error = new Error(msg.error);
        error.name = msg.errorName ?? "Error";
        entry.reject(error);
      }
    });

    // A worker that dies -- failed script load, an uncaught throw, the
    // documented innerHTML-remount hazard -- must REJECT its callers, not
    // strand them. Every hang reported against this widget traced back to a
    // promise with nobody left to settle it.
    const fail = (reason: string) => () => this.failAll(reason);
    this.worker.addEventListener("error", fail("The BitLogin crypto worker stopped unexpectedly."));
    this.worker.addEventListener(
      "messageerror",
      fail("The BitLogin crypto worker sent an unreadable message.")
    );
  }

  /** Settles every outstanding call with an error. Idempotent. */
  private failAll(reason: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  private call<A extends WorkerAction>(
    action: A,
    payload: WorkerActionMap[A][0],
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<WorkerActionMap[A][1]> {
    if (this.dead) {
      return Promise.reject(new Error(this.deadReason));
    }
    const id = `${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BitLogin's ${action} call timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const request: WorkerRequest = { id, action, payload };
      this.worker.postMessage(request);
    });
  }

  configure(payload: ConfigurePayload) {
    return this.call("configure", payload);
  }
  register(payload: RegisterPayload) {
    return this.call("register", payload);
  }
  previewImportKey(payload: PreviewImportKeyPayload) {
    return this.call("previewImportKey", payload);
  }
  login(payload: LoginPayload) {
    return this.call("login", payload);
  }
  recover(payload: RecoverPayload) {
    return this.call("recover", payload);
  }
  completeRecovery(payload: CompleteRecoveryPayload) {
    return this.call("completeRecovery", payload);
  }
  changePassword(payload: ChangePasswordPayload) {
    return this.call("changePassword", payload);
  }
  publishProfileAndRelayLists(payload: PublishProfilePayload) {
    return this.call("publishProfileAndRelayLists", payload);
  }
  getPublicKey() {
    return this.call("getPublicKey", {});
  }
  signEvent(payload: SignEventPayload) {
    return this.call("signEvent", payload);
  }
  nip44Encrypt(payload: Nip44EncryptPayload) {
    return this.call("nip44Encrypt", payload);
  }
  nip44Decrypt(payload: Nip44DecryptPayload) {
    return this.call("nip44Decrypt", payload);
  }
  nip04Encrypt(payload: Nip04EncryptPayload) {
    return this.call("nip04Encrypt", payload);
  }
  nip04Decrypt(payload: Nip04DecryptPayload) {
    return this.call("nip04Decrypt", payload);
  }
  exportIdentity() {
    return this.call("exportIdentity", {});
  }
  buildRecoveryExport() {
    return this.call("buildRecoveryExport", {});
  }
  repairReplicas() {
    return this.call("repairReplicas", {});
  }
  previewPhraseRebuild(payload: PhraseRebuildPayload) {
    return this.call("previewPhraseRebuild", payload);
  }
  rebuildFromPhrase(payload: PhraseRebuildPayload) {
    return this.call("rebuildFromPhrase", payload);
  }
  checkReplicaHealth() {
    return this.call("checkReplicaHealth", {});
  }
  getSessionStatus() {
    return this.call("getSessionStatus", {});
  }
  restoreSession() {
    return this.call("restoreSession", {});
  }
  handoffBegin() {
    return this.call("handoffBegin", {});
  }
  handoffExport(payload: HandoffExportPayload) {
    return this.call("handoffExport", payload);
  }
  handoffAccept(payload: HandoffSealed) {
    return this.call("handoffAccept", payload);
  }
  loadProfile(payload: LoadProfilePayload = {}) {
    return this.call("loadProfile", payload);
  }
  accountsList() {
    return this.call("accountsList", {});
  }
  accountsSwitch(pubkey: string) {
    return this.call("accountsSwitch", { pubkey });
  }
  accountsAdd() {
    return this.call("accountsAdd", {});
  }
  accountsRemove(pubkey: string) {
    return this.call("accountsRemove", { pubkey });
  }
  takeBack(payload: TakeBackPayload) {
    return this.call("takeBack", payload);
  }
  signerCheck(payload: SignerSitePayload) {
    return this.call("signerCheck", payload);
  }
  lockStatus() {
    return this.call("lockStatus", {});
  }
  lockEnable(payload: LockPinPayload) {
    return this.call("lockEnable", payload);
  }
  lockSetDevice(payload: LockDevicePayload) {
    return this.call("lockSetDevice", payload);
  }
  lockRemoveDevice() {
    return this.call("lockRemoveDevice", {});
  }
  lockDisable() {
    return this.call("lockDisable", {});
  }
  lockNow() {
    return this.call("lockNow", {});
  }
  lockOpen(payload: LockOpenPayload) {
    return this.call("lockOpen", payload);
  }
  roomPass(payload: RoomPassPayload) {
    return this.call("roomPass", payload);
  }
  worldSave(payload: WorldSavePayload) {
    return this.call("worldSave", payload);
  }
  worldFind(payload: WorldFindPayload) {
    return this.call("worldFind", payload);
  }
  worldOpen(payload: WorldOpenPayload) {
    return this.call("worldOpen", payload);
  }
  worldFollow(payload: WorldFollowPayload) {
    return this.call("worldFollow", payload);
  }
  worldSeal(payload: WorldSealPayload) {
    return this.call("worldSeal", payload);
  }
  worldUnwrap(payload: WorldUnwrapPayload) {
    return this.call("worldUnwrap", payload);
  }
  worldReach(payload: WorldReachPayload) {
    return this.call("worldReach", payload);
  }
  worldScore(payload: WorldScorePayload) {
    return this.call("worldScore", payload);
  }
  worldAchieve(payload: WorldAchievePayload) {
    return this.call("worldAchieve", payload);
  }
  signerKeep(payload: SignerKeepPayload) {
    return this.call("signerKeep", payload);
  }
  signerRestore(payload: SignerSitePayload) {
    return this.call("signerRestore", payload);
  }
  signerTouch(payload: SignerTouchPayload) {
    return this.call("signerTouch", payload);
  }
  signerForget(payload: SignerSitePayload) {
    return this.call("signerForget", payload);
  }
  signerHold(payload: WorkerActionMap["signerHold"][0]) {
    return this.call("signerHold", payload);
  }
  signerHeld(site: string) {
    return this.call("signerHeld", { site });
  }
  appEncrypt(payload: AppCryptPayload) {
    return this.call("appEncrypt", payload);
  }
  appDecrypt(payload: AppCryptPayload) {
    return this.call("appDecrypt", payload);
  }
  appDecryptEvent(payload: AppDecryptEventPayload) {
    return this.call("appDecryptEvent", payload);
  }
  vaultStatus() {
    return this.call("vaultStatus", {});
  }
  vaultList() {
    return this.call("vaultList", {});
  }
  vaultSaveNwc(payload: VaultSaveNwcPayload) {
    return this.call("vaultSaveNwc", payload);
  }
  driveLoad() {
    return this.call("driveLoad", {});
  }
  driveSave(changes: WorkerActionMap["driveSave"][0]) {
    return this.call("driveSave", changes);
  }
  blossomAuth(payload: WorkerActionMap["blossomAuth"][0]) {
    return this.call("blossomAuth", payload);
  }
  blossomServers() {
    return this.call("blossomServers", {});
  }
  blossomSetServers(servers: string[]) {
    return this.call("blossomSetServers", { servers });
  }
  profileContent() {
    return this.call("profileContent", {});
  }
  payProfile(pubkey: string) {
    return this.call("payProfile", { pubkey });
  }
  payListing(payload: WorkerActionMap["payListing"][0]) {
    return this.call("payListing", payload);
  }
  unlockAuth(payload: WorkerActionMap["unlockAuth"][0]) {
    return this.call("unlockAuth", payload);
  }
  receiptsLoad() {
    return this.call("receiptsLoad", {});
  }
  receiptsKeep(receipts: WorkerActionMap["receiptsKeep"][0]["receipts"]) {
    return this.call("receiptsKeep", { receipts });
  }
  ecashMints() {
    return this.call("ecashMints", {});
  }
  ecashLoad() {
    return this.call("ecashLoad", {});
  }
  ecashSetMints(mints: string[]) {
    return this.call("ecashSetMints", { mints });
  }
  ecashRoll(roll: WorkerActionMap["ecashRoll"][0]) {
    return this.call("ecashRoll", roll);
  }
  vaultFindForOrigin(payload: VaultFindForOriginPayload = {}) {
    return this.call("vaultFindForOrigin", payload);
  }
  vaultRevealNwc(payload: VaultRevealNwcPayload) {
    return this.call("vaultRevealNwc", payload);
  }
  vaultSetBinding(payload: VaultSetBindingPayload) {
    return this.call("vaultSetBinding", payload);
  }
  vaultDelete(payload: VaultDeletePayload) {
    return this.call("vaultDelete", payload);
  }
  vaultOfferCheck(payload: VaultOfferCheckPayload) {
    return this.call("vaultOfferCheck", payload);
  }

  // ---- NIP-46 remote-signer session (§LM5) ----
  nip46Connect(payload: Nip46ConnectPayload) {
    return this.call("nip46Connect", payload, NIP46_CALL_TIMEOUT_MS);
  }
  nip46NostrconnectStart(payload: Nip46NostrconnectStartPayload) {
    return this.call("nip46NostrconnectStart", payload);
  }
  nip46NostrconnectAwait() {
    return this.call("nip46NostrconnectAwait", {}, NIP46_AWAIT_TIMEOUT_MS);
  }
  nip46SignEvent(payload: SignEventPayload) {
    return this.call("nip46SignEvent", payload, NIP46_CALL_TIMEOUT_MS);
  }
  nip46Nip44Encrypt(payload: Nip44EncryptPayload) {
    return this.call("nip46Nip44Encrypt", payload, NIP46_CALL_TIMEOUT_MS);
  }
  nip46Nip44Decrypt(payload: Nip44DecryptPayload) {
    return this.call("nip46Nip44Decrypt", payload, NIP46_CALL_TIMEOUT_MS);
  }
  nip46Nip04Encrypt(payload: Nip04EncryptPayload) {
    return this.call("nip46Nip04Encrypt", payload, NIP46_CALL_TIMEOUT_MS);
  }
  nip46Nip04Decrypt(payload: Nip04DecryptPayload) {
    return this.call("nip46Nip04Decrypt", payload, NIP46_CALL_TIMEOUT_MS);
  }
  nip46Disconnect() {
    return this.call("nip46Disconnect", {});
  }
  logout() {
    return this.call("logout", {});
  }

  terminate(reason?: string): void {
    this.dead = true;
    if (reason) this.deadReason = reason;
    this.worker.terminate();
    // terminate() silently kills in-flight work; without this every caller
    // waits forever on a worker that no longer exists. Reject with the same
    // reason later calls get, so an in-flight signEvent and a subsequent one
    // fail identically and legibly.
    this.failAll(this.deadReason);
  }
}
