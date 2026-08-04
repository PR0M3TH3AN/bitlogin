/** Serverless Google on-ramp (centralized-onramps.md §CO3.3) — pure logic.
 *
 * "Continue with Google" with NO third party and NO server anywhere: the
 * credential of a standard BitLogin capsule account lives in the USER'S OWN
 * Google Drive app-data folder, readable only through the host's OAuth client
 * ID. Google authenticates the user; Google stores the user's own secret; the
 * static widget does everything else.
 *
 * Flow: a popup navigates to Google's OAuth endpoint (plain implicit grant,
 * `response_type=token` — no external script, so a strict `script-src 'self'`
 * CSP survives). Google redirects back to the HOST'S OWN page; the widget
 * instance in the popup finds the token fragment and posts it to the opener
 * (same-origin, exact state nonce). The opener then talks to the Drive API
 * directly: read the credential file and run the ordinary password login, or
 * — for a first visit — register client-side and store the credential.
 *
 * Custody statement (§CO7): compromise of the Google account is compromise of
 * the password (§14 of the spec analyzes exactly that); nobody else holds
 * anything. Hosts must allow https://www.googleapis.com in connect-src and
 * register the widget page's exact URL as an OAuth redirect URI.
 */
import { randomBytes, bytesToHex } from "@bitlogin/core/crypto";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
export const GOOGLE_DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const CREDENTIAL_FILE_NAME = "bitlogin-credential-v1.json";

export interface GoogleOnrampConfig {
  clientId: string;
}

export function parseGoogleOnrampConfig(clientId: string | null): GoogleOnrampConfig | undefined {
  const trimmed = clientId?.trim();
  if (!trimmed) return undefined;
  return { clientId: trimmed };
}

export function newGoogleOnrampState(): string {
  return bytesToHex(randomBytes(16));
}

/**
 * The popup's destination. redirectUri must be the exact page URL the host
 * registered with Google — by design the page embedding the widget itself,
 * so no extra callback artifact needs deploying.
 */
export function buildGoogleAuthUrl(config: GoogleOnrampConfig, redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("scope", DRIVE_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

/** The current page's URL with query and fragment stripped — what the host
 *  registers as the redirect URI, and what the popup is sent back to. */
export function currentRedirectUri(location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}`;
}

/**
 * Parses Google's redirect fragment in the popup. Returns null when the
 * fragment is not an OAuth callback at all (the common case: every ordinary
 * page load), a token on success, or the error Google reported.
 */
export function parseGoogleCallbackFragment(
  hash: string
): { state: string; accessToken: string } | { state: string; error: string } | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return null;
  const params = new URLSearchParams(fragment);
  const state = params.get("state");
  if (!state) return null;
  const error = params.get("error");
  if (error) return { state, error };
  const accessToken = params.get("access_token");
  if (!accessToken) return null;
  return { state, accessToken };
}

/** The popup -> opener relay frame. Same-origin by construction (the popup IS
 *  a page of this site); still validated against the exact state nonce. */
export interface GoogleTokenMessage {
  type: "bitlogin:onramp:google-token";
  state: string;
  accessToken?: string;
  error?: string;
}

export function buildGoogleTokenMessage(
  parsed: { state: string; accessToken: string } | { state: string; error: string }
): GoogleTokenMessage {
  return "accessToken" in parsed
    ? { type: "bitlogin:onramp:google-token", state: parsed.state, accessToken: parsed.accessToken }
    : { type: "bitlogin:onramp:google-token", state: parsed.state, error: parsed.error };
}

export function validateGoogleTokenMessage(
  event: { origin: string; data: unknown },
  expected: { origin: string; state: string }
): { accessToken: string } | { error: string } | null {
  if (event.origin !== expected.origin) return null;
  const data = event.data as Partial<GoogleTokenMessage> | null | undefined;
  if (!data || typeof data !== "object") return null;
  if (data.type !== "bitlogin:onramp:google-token") return null;
  if (data.state !== expected.state) return null;
  if (typeof data.accessToken === "string" && data.accessToken) return { accessToken: data.accessToken };
  if (typeof data.error === "string" && data.error) return { error: data.error };
  return null;
}

export interface DriveCredential {
  loginName: string;
  password: string;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

async function requireOk(response: Response, doing: string): Promise<Response> {
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Google did not accept the sign-in while ${doing} (HTTP ${response.status}). Try "Continue with Google" again.`);
  }
  if (!response.ok) {
    throw new Error(`Google Drive failed while ${doing} (HTTP ${response.status}). Try again in a moment.`);
  }
  return response;
}

/**
 * Looks up the stored credential in the user's app-data folder. Resolves the
 * credential for a returning user, or null for a first-time user.
 */
export async function findDriveCredential(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<DriveCredential | null> {
  const query = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name = '${CREDENTIAL_FILE_NAME}'`,
    fields: "files(id)"
  });
  const listResponse = await requireOk(
    await fetchImpl(`${GOOGLE_DRIVE_API}/files?${query.toString()}`, { headers: authHeaders(accessToken) }),
    "looking up your account"
  );
  const listing = (await listResponse.json()) as { files?: Array<{ id?: string }> };
  const fileId = listing.files?.[0]?.id;
  if (!fileId) return null;

  const readResponse = await requireOk(
    await fetchImpl(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: authHeaders(accessToken)
    }),
    "reading your sign-in"
  );
  let parsed: { v?: unknown; loginName?: unknown; password?: unknown };
  try {
    parsed = (await readResponse.json()) as typeof parsed;
  } catch {
    throw new Error("The sign-in data stored in your Google account is unreadable.");
  }
  if (typeof parsed.loginName !== "string" || !parsed.loginName || typeof parsed.password !== "string" || !parsed.password) {
    throw new Error("The sign-in data stored in your Google account is incomplete.");
  }
  return { loginName: parsed.loginName, password: parsed.password };
}

/**
 * Stores a freshly registered credential as the user's app-data file. Called
 * once per registration; a failure means nobody is holding the credential, so
 * the caller must force the phrase ceremony (the no-orphan rule, §CO5).
 */
export async function storeDriveCredential(
  accessToken: string,
  credential: DriveCredential,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const boundary = `bitlogin-${bytesToHex(randomBytes(8))}`;
  const metadata = JSON.stringify({ name: CREDENTIAL_FILE_NAME, parents: ["appDataFolder"] });
  const content = JSON.stringify({ v: 1, loginName: credential.loginName, password: credential.password });
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const response = await fetchImpl(`${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
    method: "POST",
    headers: {
      ...authHeaders(accessToken),
      "content-type": `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!response.ok) {
    throw new Error(
      `Google Drive could not save your sign-in (HTTP ${response.status}). Your account was created — save the recovery phrase shown next, and you can retry "Continue with Google" later.`
    );
  }
}
