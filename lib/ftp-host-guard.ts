// Guard for FTP/SFTP hosts typed in by dealers (self-service exports).
// Server-only.
//
// The push runs from the app box, which can reach the private VPC (the PDF
// service, the instance metadata endpoint, ...). A dealer-supplied host must
// therefore resolve ONLY to public addresses — same rule as the extract-styles
// SSRF guard in da-pdf-service. SuperAdmin feeds are not checked (operator-
// entered, and nothing about them changes).
//
// EXPORT_FTP_ALLOW_HOSTS (comma-separated exact hostnames) exempts named hosts
// — for a controlled test server only; leave it unset in normal operation.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||   // CGN
    (a === 169 && b === 254) ||             // link-local + metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224                                // multicast + reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") ||
    s.startsWith("fea") || s.startsWith("feb") || s.startsWith("ff");
}

export function cleanFtpHost(url: string): string {
  return String(url ?? "").replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").trim();
}

/** null when the host is acceptable, otherwise a user-facing reason. */
export async function checkPublicFtpHost(rawHost: string): Promise<string | null> {
  const host = cleanFtpHost(rawHost);
  if (!host) return "Enter the FTP host.";
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !isIP(host)) return "The FTP host contains invalid characters.";
  const allow = (process.env.EXPORT_FTP_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.includes(host.toLowerCase())) return null;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return `Couldn't find the host "${host}". Check the spelling.`;
  }
  if (addrs.length === 0) return `Couldn't find the host "${host}".`;
  for (const { address } of addrs) {
    const bad = isIP(address) === 6 ? isPrivateV6(address) : isPrivateV4(address);
    if (bad) return `"${host}" points to a private network address, which isn't allowed. Use your provider's public FTP host.`;
  }
  return null;
}
