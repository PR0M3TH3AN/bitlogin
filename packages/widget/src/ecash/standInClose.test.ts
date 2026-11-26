/**
 * A stand-in server's close() never waits on a connection a page keeps open (2026-11-26: the §SW19 panel e2e hung
 * at `await mint.close()` under load, waiting on a connection its wallet held). Each failing before the mend.
 */
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startMockMint } from "./mockMint.js";
import { startMockUnlock } from "../pay/mockUnlock.js";
import { startMockBlossom } from "../drive/mockBlossom.js";

/** A request whose body never ends: the server is mid-request on that connection until it is cut. */
function holdOpen(url: string): () => void {
  const u = new URL(url);
  const req = request({ host: u.hostname, port: u.port, path: "/v1/checkstate", method: "POST", headers: { "content-type": "application/json", "content-length": "1000" } });
  req.on("error", () => {});
  req.write("{");
  return () => req.destroy();
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "closed"), new Promise<string>((done) => setTimeout(() => done("still waiting"), ms))]);

const left: (() => void)[] = [];
afterEach(() => {
  for (const cut of left.splice(0)) cut();
});

describe("a stand-in server, closed while a page holds a connection to it", () => {
  it("the stand-in mint closes at once", async () => {
    const mint = await startMockMint();
    left.push(holdOpen(mint.url));
    await new Promise((done) => setTimeout(done, 100));
    expect(await within(mint.close(), 2000)).toBe("closed");
  });

  it("the stand-in unlock service closes at once", async () => {
    const unlock = await startMockUnlock({ invoice: () => "lnbc1", paid: () => false });
    left.push(holdOpen(unlock.url));
    await new Promise((done) => setTimeout(done, 100));
    expect(await within(unlock.close(), 2000)).toBe("closed");
  });

  it("the stand-in file server closes at once", async () => {
    const blossom = await startMockBlossom();
    left.push(holdOpen(blossom.url));
    await new Promise((done) => setTimeout(done, 100));
    expect(await within(blossom.close(), 2000)).toBe("closed");
  });
});
