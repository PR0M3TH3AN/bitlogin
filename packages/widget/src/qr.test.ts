import { describe, expect, it } from "vitest";
import qrcodeGenerator from "qrcode-generator";
import { renderQrSvg } from "./qr.js";

const SAMPLE =
  "nostrconnect://" +
  "ab".repeat(32) +
  "?relay=wss%3A%2F%2Frelay.example&secret=0123456789abcdef&name=BitLogin";

describe("renderQrSvg", () => {
  it("renders a complete standalone SVG with backing, eyes, and dots", () => {
    const svg = renderQrSvg(SAMPLE);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // One opaque backing rect plus three finder eyes of two rects each.
    expect(svg.match(/<rect /gu)!.length).toBe(1 + 3 * 2);
    // Data modules are circles -- the "dots" -- and there are plenty of them.
    expect(svg.match(/<circle /gu)!.length).toBeGreaterThan(50);
  });

  it("draws exactly the dark data modules the encoder produced, minus finder zones", () => {
    const qr = qrcodeGenerator(0, "M");
    qr.addData(SAMPLE);
    qr.make();
    const n = qr.getModuleCount();
    let expected = 0;
    const inEye = (r: number, c: number) =>
      (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!inEye(r, c) && qr.isDark(r, c)) expected++;
      }
    }
    const svg = renderQrSvg(SAMPLE);
    expect(svg.match(/<circle /gu)!.length).toBe(expected);
  });

  it("keeps the quiet zone: no dot within four modules of the edge", () => {
    const svg = renderQrSvg(SAMPLE);
    const centers = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/gu)].map((m) => [
      Number(m[1]),
      Number(m[2])
    ]);
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/u.exec(svg)!;
    const size = Number(viewBox[1]);
    for (const [cx, cy] of centers) {
      expect(cx).toBeGreaterThanOrEqual(4);
      expect(cy).toBeGreaterThanOrEqual(4);
      expect(cx).toBeLessThanOrEqual(size - 4);
      expect(cy).toBeLessThanOrEqual(size - 4);
    }
  });

  it("escapes nothing it shouldn't: the payload never appears in the markup", () => {
    // The QR encodes the URI as modules; the raw string (with its secret) must
    // not leak into the SVG text.
    const svg = renderQrSvg(SAMPLE);
    expect(svg).not.toContain("nostrconnect");
    expect(svg).not.toContain("secret");
  });
});
