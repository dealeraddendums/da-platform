// Client-side perspective flatten (homography) for the Buyer's Guide label
// alignment tool (2026-08-26 correctness fix): a phone photo shows the label
// tilted inside a larger frame, so overlaying fields on the RAW photo is not
// predictive of the print. The dealer outlines the label's four corners; this
// warps/crops the photo so the label fills a normalized 612×792 image (the
// FTC guide's letter-size coordinate space — 1px = 1pt). All field placement,
// auto-detect, and nudging then happen in LABEL coordinates. Pure browser
// code — the photo never leaves the client except the flattened form sent to
// the one-time auto-detect call.

export type Pt = { x: number; y: number };

/** Solve the 3×3 homography H that maps DESTINATION unit-square corners
 *  (0,0),(1,0),(1,1),(0,1) onto the SOURCE quad corners (TL,TR,BR,BL), so a
 *  destination pixel back-maps into the photo. Standard 8-unknown DLT via
 *  Gaussian elimination. */
export function homographyFromUnitSquare(quad: [Pt, Pt, Pt, Pt]): number[] {
  const dst = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // A · h = b with h = [h11..h32] (h33 = 1)
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i];
    const { x, y } = quad[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  // Gaussian elimination with partial pivoting
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const h = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * h[c];
    h[r] = s / (A[r][r] || 1e-12);
  }
  return [...h, 1]; // h11 h12 h13 h21 h22 h23 h31 h32 h33
}

/**
 * Warp the region of `img` bounded by `quad` (TL,TR,BR,BL in image pixels)
 * into a straight outW×outH canvas (bilinear sampling). Returns a JPEG data
 * URL sized for both the alignment backdrop and the vision call.
 */
export function flattenQuadToDataUrl(
  img: HTMLImageElement,
  quad: [Pt, Pt, Pt, Pt],
  outW = 612,
  outH = 792,
): string {
  const src = document.createElement("canvas");
  src.width = img.naturalWidth; src.height = img.naturalHeight;
  const sctx = src.getContext("2d");
  if (!sctx) throw new Error("canvas 2d unavailable");
  sctx.drawImage(img, 0, 0);
  const sdata = sctx.getImageData(0, 0, src.width, src.height).data;
  const sw = src.width, sh = src.height;

  const H = homographyFromUnitSquare(quad);
  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("canvas 2d unavailable");
  const odata = octx.createImageData(outW, outH);
  const o = odata.data;

  for (let y = 0; y < outH; y++) {
    const v = y / outH;
    for (let x = 0; x < outW; x++) {
      const u = x / outW;
      const w = H[6] * u + H[7] * v + H[8];
      const sx = (H[0] * u + H[1] * v + H[2]) / w;
      const sy = (H[3] * u + H[4] * v + H[5]) / w;
      const di = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        o[di] = o[di + 1] = o[di + 2] = 255; o[di + 3] = 255;
        continue;
      }
      // bilinear
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const i00 = (y0 * sw + x0) * 4 + ch;
        const i10 = i00 + 4;
        const i01 = i00 + sw * 4;
        const i11 = i01 + 4;
        o[di + ch] =
          sdata[i00] * (1 - fx) * (1 - fy) + sdata[i10] * fx * (1 - fy) +
          sdata[i01] * (1 - fx) * fy + sdata[i11] * fx * fy;
      }
      o[di + 3] = 255;
    }
  }
  octx.putImageData(odata, 0, 0);
  return out.toDataURL("image/jpeg", 0.85);
}

/**
 * Cheap corner seed: find the paper (bright region) in a downsampled copy and
 * return the four extreme bright pixels as TL/TR/BR/BL guesses. Falls back to
 * a 6% inset when the scene is too uniform. The dealer confirms/adjusts the
 * dots either way — this only saves dragging distance.
 */
export function seedCorners(img: HTMLImageElement): [Pt, Pt, Pt, Pt] {
  const W = 120;
  const scale = img.naturalWidth / W;
  const Hh = Math.max(1, Math.round(img.naturalHeight / scale));
  const c = document.createElement("canvas");
  c.width = W; c.height = Hh;
  const ctx = c.getContext("2d");
  const inset = (): [Pt, Pt, Pt, Pt] => {
    const ix = img.naturalWidth * 0.06, iy = img.naturalHeight * 0.06;
    return [
      { x: ix, y: iy },
      { x: img.naturalWidth - ix, y: iy },
      { x: img.naturalWidth - ix, y: img.naturalHeight - iy },
      { x: ix, y: img.naturalHeight - iy },
    ];
  };
  if (!ctx) return inset();
  ctx.drawImage(img, 0, 0, W, Hh);
  const d = ctx.getImageData(0, 0, W, Hh).data;
  // brightness threshold relative to the image's own max (paper = brightest)
  let maxLum = 0;
  const lum = new Float32Array(W * Hh);
  for (let i = 0; i < W * Hh; i++) {
    const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    lum[i] = l;
    if (l > maxLum) maxLum = l;
  }
  const th = maxLum * 0.82;
  // extremes among bright pixels: TL = min(x+y), TR = max(x−y), BR = max(x+y), BL = min(x−y)
  let tl: Pt | null = null, tr: Pt | null = null, br: Pt | null = null, bl: Pt | null = null;
  let tlv = Infinity, trv = -Infinity, brv = -Infinity, blv = Infinity;
  let brightCount = 0;
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    if (lum[y * W + x] < th) continue;
    brightCount++;
    const s = x + y, dxy = x - y;
    if (s < tlv) { tlv = s; tl = { x, y }; }
    if (s > brv) { brv = s; br = { x, y }; }
    if (dxy > trv) { trv = dxy; tr = { x, y }; }
    if (dxy < blv) { blv = dxy; bl = { x, y }; }
  }
  // A near-full-frame bright scan (scanner) or a failed find → inset default.
  if (!tl || !tr || !br || !bl || brightCount > W * Hh * 0.92) return inset();
  const up = (p: Pt): Pt => ({ x: Math.min(Math.max(p.x * scale, 0), img.naturalWidth), y: Math.min(Math.max(p.y * scale, 0), img.naturalHeight) });
  return [up(tl), up(tr), up(br), up(bl)];
}

/**
 * Deterministic GLOBAL offset for a flattened label image: find the printed
 * form's dark-pixel bounding box and compare its center to the reference
 * printed area (54pt margins on the 612×792 FTC page). Pure pixel math — the
 * vision model's global suggestion wobbles ±40pt between runs on the same
 * image (its form-box estimate), which showed up as "fields drop an inch a
 * few seconds after straighten"; this is exact and repeatable. Returns null
 * when the image doesn't look like a printed form (caller falls back).
 */
export function printAreaGlobal(img: HTMLImageElement): { x: number; y: number } | null {
  const W = 612, H = 792;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Robust ink/paper threshold: midpoint of the 5th and 90th luminance
  // percentiles (ink vs paper) — photo exposure independent.
  const sorted = Float32Array.from(lum).sort();
  const ink = sorted[Math.floor(sorted.length * 0.05)];
  const paper = sorted[Math.floor(sorted.length * 0.90)];
  if (paper - ink < 40) return null; // no real contrast — not a printed form
  const th = (ink + paper) / 2;

  // Bounding box of rows/cols with enough dark pixels (noise/dust rejected).
  // The scan skips an 8px border: the warp's out-of-quad fill and JPEG edge
  // fringes leave faint gray lines at the extreme page border that otherwise
  // masquerade as content (measured: they dragged the box bottom from 738 to
  // 791 on a low-contrast back page). The printed area starts ~54pt in, so
  // the inset can never clip real form content.
  const INSET = 8, MIN_RUN = 6;
  const rowCount = new Int32Array(H), colCount = new Int32Array(W);
  for (let y = INSET; y < H - INSET; y++) for (let x = INSET; x < W - INSET; x++) {
    if (lum[y * W + x] < th) { rowCount[y]++; colCount[x]++; }
  }
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < H; y++) if (rowCount[y] >= MIN_RUN) { if (top < 0) top = y; bottom = y; }
  for (let x = 0; x < W; x++) if (colCount[x] >= MIN_RUN) { if (left < 0) left = x; right = x; }
  if (top < 0 || left < 0) return null;
  const w = right - left, h = bottom - top;
  // Sanity: the FTC printed area is ~504×684pt — reject wildly different
  // boxes (severe crop, blank page, photo of something else).
  if (w < 300 || h < 450 || w > 596 || h > 776) return null;
  // Compare CENTERS (robust to slight scale differences the offsets-only
  // config can't express anyway). Reference print rect: 54,54 → 558,738.
  const clamp = (n: number) => Math.max(-150, Math.min(150, Math.round(n)));
  return { x: clamp((left + right) / 2 - 306), y: clamp(-((top + bottom) / 2 - 396)) }; // flip to bottom-left origin
}
