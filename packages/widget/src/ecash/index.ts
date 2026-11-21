/**
 * The ecash wallet, for BitLogin's own pages (docs/ecash.md). Built as
 * `bitlogin-ecash.js` and loaded only where a wallet is opened: it brings the
 * Cashu protocol with it, which nothing else needs.
 */
export { createEcashWallet, EcashError, type EcashStore, type EcashWalletApi, type FundQuote, type PayQuote } from "./wallet.js";
export { cleanInvoice, cleanMint } from "./nip60.js";
export { renderQrSvg } from "../qr.js";
