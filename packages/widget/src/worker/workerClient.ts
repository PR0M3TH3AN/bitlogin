/** Main-thread proxy for the crypto Web Worker. Every method returns a Promise resolving to public data only. */
import type {
  WorkerActionMap,
  WorkerAction,
  WorkerRequest,
  WorkerResponse,
  ConfigurePayload,
  RegisterPayload,
  LoginPayload,
  RecoverPayload,
  CompleteRecoveryPayload,
  ChangePasswordPayload,
  PublishProfilePayload,
  SignEventPayload,
  Nip44EncryptPayload,
  Nip44DecryptPayload
} from "./protocol.js";

export class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private counter = 0;

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
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const error = new Error(msg.error);
        error.name = msg.errorName ?? "Error";
        entry.reject(error);
      }
    });
  }

  private call<A extends WorkerAction>(action: A, payload: WorkerActionMap[A][0]): Promise<WorkerActionMap[A][1]> {
    const id = `${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
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
  exportIdentity() {
    return this.call("exportIdentity", {});
  }
  buildRecoveryExport() {
    return this.call("buildRecoveryExport", {});
  }
  repairReplicas() {
    return this.call("repairReplicas", {});
  }
  getSessionStatus() {
    return this.call("getSessionStatus", {});
  }
  logout() {
    return this.call("logout", {});
  }

  terminate(): void {
    this.worker.terminate();
  }
}
