// DA-CRM call recordings: we store references, not bytes — except that
// Dialpad's recording/voicemail URLs aren't guaranteed to stay valid, so each
// one is copied once to S3 (dealer-addendums, us-west-1) at
//   crm/{company_id | "unmatched"}/calls/{crm_calls.id}.mp3
// and played back through a short-lived signed URL. The key embeds two random
// UUIDs; the bucket is public-read for dealer-site PDFs, so never put
// guessable names under crm/. purge-old-pdfs skips crm/ (recordings are kept).
// Company files and team photos live under the same prefix (see below).
// CRM_COPY_RECORDINGS=0 turns the copy off (playback then proxies Dialpad).
// Admin (auto-record) URLs are browser-only; those download through a Dialpad
// recording share link (fetchDialpadRecording in lib/crm/dialpad.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fetchDialpadRecording } from "./dialpad";
import { crmEnv } from "./env";

const BUCKET = "dealer-addendums";
const MAX_BYTES = 200 * 1024 * 1024;

function s3(): S3Client {
  return new S3Client({
    region: "us-west-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

export function recordingCopyEnabled(): boolean {
  return crmEnv("CRM_COPY_RECORDINGS") !== "0" && !!process.env.AWS_ACCESS_KEY_ID;
}

export function recordingKey(companyId: string | null, callId: string): string {
  return `crm/${companyId ?? "unmatched"}/calls/${callId}.mp3`;
}

/** Download `url` and store it under the call's key; records recording_s3_key. */
export async function copyRecordingToS3(admin: any, callId: string, companyId: string | null, url: string): Promise<string | null> {
  const res = await fetchDialpadRecording(url);
  if (!res.ok) {
    console.error(`[crm-recording] fetch ${callId} → ${res.status}`);
    return null;
  }
  const type = res.headers.get("content-type") ?? "";
  if (type && !/^(audio\/|application\/octet-stream|binary\/)/i.test(type)) {
    // An HTML login page instead of audio means the URL needs auth we don't have.
    console.error(`[crm-recording] ${callId}: unexpected content-type ${type}`);
    return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length || body.length > MAX_BYTES) {
    console.error(`[crm-recording] ${callId}: bad size ${body.length}`);
    return null;
  }
  const key = recordingKey(companyId, callId);
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: type.startsWith("audio/") ? type : "audio/mpeg",
  }));
  const { error } = await admin.from("crm_calls").update({ recording_s3_key: key }).eq("id", callId);
  if (error) console.error(`[crm-recording] ${callId}: save key: ${error.message}`);
  return key;
}

export async function signRecordingKey(key: string): Promise<string> {
  return signCrmKey(key);
}

// ── Company files (feed-request PDFs etc.) and team photos ──────────────────

export async function putCrmObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** Signed GET, optionally forcing a download filename. */
export async function signCrmKey(key: string, downloadName?: string, expiresIn = 900): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/["\\\r\n]/g, "_")}"` } : {}),
  }), { expiresIn });
}
