/**
 * The widget never reads a slow or unreached relay as "no account" (2026-11-26, the record-not-found fault; the
 * orchestrator's words): RelaysSlowError shows its own words and Try again; on the passkey and recovery paths "make a
 * new account" or "rebuild from your phrase" is offered only as a second, plainly worded press, never as the next
 * screen. A password sign-in's Try again is tested in Chromium (e2e/passkey.e2e.test.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const element = readFileSync(new URL("./element.ts", import.meta.url), "utf8");
const body = (name: string) => element.slice(element.indexOf(`private async ${name}(`), element.indexOf("\n  }\n", element.indexOf(`private async ${name}(`)));

describe("where some relays didn't answer", () => {
  it("every sign-in and recovery path takes RelaysSlowError to Try again before anything else", () => {
    for (const path of ["attemptLogin", "passkeyLogin", "recoverFromPhrase"]) expect(body(path), path).toContain("this.slowRelays(err, () => this.");
  });

  it("a passkey's new account and a recovery's rebuild are only a second press, in plain words", () => {
    const passkey = body("passkeyLogin");
    expect(passkey).toContain('label: "Make a new account anyway"');
    // The slow case is handled before the "no account" case that goes on to passkey-create.
    expect(passkey.indexOf("this.slowRelays(err")).toBeGreaterThan(-1);
    const recovery = body("recoverFromPhrase");
    expect(recovery).toContain('label: "Rebuild from your phrase anyway"');
    expect(recovery.indexOf("this.slowRelays(err")).toBeLessThan(recovery.indexOf('err.name !== "AccountNotFoundError"'));
    // The screen offers Try again first, and the other way only where a path has one.
    const screen = element.slice(element.indexOf('case "relays-slow": {'), element.indexOf('case "recover-rebuild": {'));
    expect(screen.indexOf('data-action="relays-retry"')).toBeLessThan(screen.indexOf('data-action="relays-anyway"'));
    expect(screen).toContain("${slow.anyway ? ");
  });
});
