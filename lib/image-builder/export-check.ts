// Pure export validator — shared by the export route and the unit tests.

import { readPngInfo } from "./png-dpi";
import { IMAGE_TYPES, PPM_150_DPI, type ImageType } from "./spec";

/**
 * Check a rendered PNG against its image type's spec: PNG signature, exact
 * pixel dimensions, a pHYs chunk of exactly 150 DPI (5906 px/m, unit=metre),
 * and the byte cap. Returns an error string or null.
 */
export function checkExport(bytes: Uint8Array, imageType: ImageType): string | null {
  const spec = IMAGE_TYPES[imageType];
  let info;
  try { info = readPngInfo(bytes); } catch { return "Export is not a valid PNG"; }
  if (info.width !== spec.width || info.height !== spec.height) {
    return `Export is ${info.width}×${info.height}; ${spec.label} must be exactly ${spec.width}×${spec.height}`;
  }
  const p = info.phys;
  if (!p || p.unit !== 1 || p.ppmX !== PPM_150_DPI || p.ppmY !== PPM_150_DPI) {
    return "Export is not tagged 150 DPI (pHYs 5906 px/m)";
  }
  if (bytes.length > spec.maxBytes) {
    return `Export is ${(bytes.length / 1048576).toFixed(1)} MB; ${spec.label} max is ${spec.maxBytes / 1048576} MB`;
  }
  return null;
}
