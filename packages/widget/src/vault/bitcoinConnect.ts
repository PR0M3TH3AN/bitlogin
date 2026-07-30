/**
 * Bitcoin Connect as a wallet CHOOSER for NWC import (vault-ux.md §2).
 *
 * The discipline here is lifted from Satisfied's production integration,
 * which learned each rule on a real device:
 *
 * - Chooser only. BC's job ends the moment a wallet hands over the URI; the
 *   encrypted vault record is the sole owner afterward. BC is disconnected
 *   and its localStorage config cleared so no plaintext copy of the secret
 *   outlives the ceremony (§CV17).
 * - Loaded lazily. BC pulls in @getalby/sdk, lightning-tools, zustand, and a
 *   QR renderer — heavier than the whole widget core. The dynamic import
 *   below builds as its own chunk, downloaded only when a user actually
 *   opens the wallet-connect flow.
 * - NO numeric budget in authorizationUrlOptions. The field's unit is not
 *   interoperable (CoinOS reads millisats, Alby Hub reads sats); the budget
 *   belongs on the wallet's own authorization page, which is also the only
 *   place it is actually enforced.
 * - persistConnection/autoConnect off, and the config key cleared even so:
 *   BC must never restore itself as a competing provider on a later load.
 *
 * Host CSP note: BC's Lit components set inline style ATTRIBUTES, so
 * embedding pages need `style-src-attr 'unsafe-inline'` for this flow (the
 * narrowest directive that covers it — hashes cannot).
 */

const BC_STORAGE_KEY = "bc:config";
const NWC_URI = /^nostr\+walletconnect:\/\//iu;

type BitcoinConnectModule = typeof import("@getalby/bitcoin-connect");

let modulePromise: Promise<BitcoinConnectModule> | null = null;

function loadBitcoinConnect(appName: string): Promise<BitcoinConnectModule> {
  if (!modulePromise) {
    // BC runs its restore logic at module evaluation, before init() can apply
    // persistConnection:false — clear any stale key first so an old connector
    // can never race this flow.
    try {
      localStorage.removeItem(BC_STORAGE_KEY);
    } catch {
      // Storage being blocked only disables BC's own persistence, which is
      // what this flow wants anyway.
    }
    modulePromise = import("@getalby/bitcoin-connect")
      .then((module) => {
        module.init({
          appName,
          filters: ["nwc"],
          showBalance: false,
          autoConnect: false,
          persistConnection: false,
          providerConfig: {
            nwc: {
              authorizationUrlOptions: {
                name: appName,
                requestMethods: ["pay_invoice"]
              }
            }
          }
        });
        return module;
      })
      .catch((error: unknown) => {
        modulePromise = null; // a transient chunk failure must be retryable
        throw error;
      });
  }
  return modulePromise;
}

function isCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /closed|cancell?ed|dismissed|aborted/iu.test(message);
}

/**
 * Opens Bitcoin Connect's wallet chooser and resolves the NWC URI, or null
 * when the user dismisses the modal (an ordinary outcome, not an error).
 */
export async function chooseWalletViaBitcoinConnect(appName: string): Promise<string | null> {
  const bc = await loadBitcoinConnect(appName);
  try {
    const provider = await bc.requestProvider();
    const configUrl = bc.getConnectorConfig()?.nwcUrl;
    const providerUrl = (provider as unknown as { client?: { nostrWalletConnectUrl?: unknown } }).client
      ?.nostrWalletConnectUrl;
    const uri = typeof configUrl === "string" ? configUrl : typeof providerUrl === "string" ? providerUrl : "";
    if (!NWC_URI.test(uri.trim())) {
      throw new Error("The wallet did not return an NWC connection. Try again or paste one manually.");
    }
    return uri.trim();
  } catch (error) {
    if (isCancellation(error)) return null;
    throw error;
  } finally {
    try {
      bc.disconnect();
    } catch {
      // The URI (if any) is already captured; connector cleanup is best-effort.
    }
    try {
      localStorage.removeItem(BC_STORAGE_KEY);
    } catch {
      // Storage can be blocked independently of connector cleanup.
    }
  }
}
