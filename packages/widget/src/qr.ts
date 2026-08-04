/** Dot-style QR rendering for the nostrconnect connection code (§LM5).
 *
 * Renders the module matrix as inline SVG: data modules become circles, and
 * the three finder "eyes" become rounded squares -- dots everywhere would look
 * uniform but measurably hurts camera lock-on, since scanners find a code BY
 * its three square eyes. Inline SVG keeps this self-contained under the
 * strict deployment CSP (no canvas, no image assets) and crisp at any size.
 *
 * The white backing rect is part of the QR, not styling: scanners need quiet
 * zone and contrast regardless of the host page's theme.
 */
import qrcodeGenerator from "qrcode-generator";

const QUIET_ZONE = 4; // modules of white margin, per the QR spec
const DOT_RADIUS = 0.42; // of a 1x1 module cell; large enough to scan, round enough to read as dots
const DARK = "#14101f";
const LIGHT = "#ffffff";

function inFinderZone(row: number, col: number, moduleCount: number): boolean {
  const nearStart = (v: number) => v < 7;
  const nearEnd = (v: number) => v >= moduleCount - 7;
  return (
    (nearStart(row) && nearStart(col)) ||
    (nearStart(row) && nearEnd(col)) ||
    (nearEnd(row) && nearStart(col))
  );
}

function finderEye(x: number, y: number): string {
  // Outer 7x7 ring drawn as a stroked rounded square, inner 3x3 filled.
  return (
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="2.1" fill="none" stroke="${DARK}" stroke-width="1"/>` +
    `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="1.1" fill="${DARK}"/>`
  );
}

/** Encodes `data` and returns a complete `<svg>` element string. */
export function renderQrSvg(data: string, ariaLabel = "QR code"): string {
  const qr = qrcodeGenerator(0, "M");
  qr.addData(data);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const size = moduleCount + QUIET_ZONE * 2;

  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${size}" height="${size}" rx="3" fill="${LIGHT}"/>`);
  parts.push(finderEye(QUIET_ZONE, QUIET_ZONE));
  parts.push(finderEye(QUIET_ZONE + moduleCount - 7, QUIET_ZONE));
  parts.push(finderEye(QUIET_ZONE, QUIET_ZONE + moduleCount - 7));

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (inFinderZone(row, col, moduleCount) || !qr.isDark(row, col)) continue;
      const cx = QUIET_ZONE + col + 0.5;
      const cy = QUIET_ZONE + row + 0.5;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${DOT_RADIUS}" fill="${DARK}"/>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${ariaLabel}" shape-rendering="geometricPrecision">${parts.join("")}</svg>`;
}
