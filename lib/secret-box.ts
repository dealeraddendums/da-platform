// Encrypt-at-rest for credentials dealers type into the app (self-service
// export FTP passwords). Server-only.
//
// AES-256-GCM with a random IV per value, stored as
//   enc:v1:<iv b64>:<tag b64>:<ciphertext b64>
// The key is FEED_CREDENTIALS_KEY (32 bytes, base64) in the box's
// .env.production — never in the repo or the browser bundle.
//
// decryptSecret() passes a value WITHOUT the prefix straight through, so the
// pre-existing SuperAdmin feeds (plain-text passwords) keep working untouched.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function key(): Buffer {
  const raw = process.env.FEED_CREDENTIALS_KEY;
  if (!raw) throw new Error("FEED_CREDENTIALS_KEY is not configured");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("FEED_CREDENTIALS_KEY must be 32 bytes (base64)");
  return k;
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!isEncryptedSecret(value)) return value;
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
