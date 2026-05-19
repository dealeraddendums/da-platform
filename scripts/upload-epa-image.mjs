// One-shot uploader for the EPA/DOT Fuel Economy infobox image.
// Runs on the EC2 against /tmp/EPA.png and writes to
// s3://new-infobox-images/EPA_Infobox_Default.png (us-east-1, the same
// bucket lib/s3-upload.ts treats as the logo/region default).

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import * as dotenv from "dotenv";
import { readFileSync, statSync } from "node:fs";
dotenv.config({ path: "/var/www/da-platform/.env.production" });

const BUCKET = "new-infobox-images";
const KEY = "EPA_Infobox_Default.png";
const LOCAL = "/tmp/EPA.png";

const s3 = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const stat = statSync(LOCAL);
console.log(`Local file: ${LOCAL} (${stat.size} bytes)`);

// Pre-flight: show what's currently there so we can compare after.
try {
  const before = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY }));
  console.log(`BEFORE: ${before.ContentLength} bytes, ETag ${before.ETag}, LastModified ${before.LastModified?.toISOString?.()}`);
} catch (e) {
  console.log(`BEFORE: head failed (${e.name ?? "?"}: ${e.message ?? ""})`);
}

const body = readFileSync(LOCAL);
await s3.send(new PutObjectCommand({
  Bucket: BUCKET,
  Key: KEY,
  Body: body,
  ContentType: "image/png",
  CacheControl: "public, max-age=300",
}));
console.log(`PUT s3://${BUCKET}/${KEY}`);

const after = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: KEY }));
console.log(`AFTER:  ${after.ContentLength} bytes, ETag ${after.ETag}, LastModified ${after.LastModified?.toISOString?.()}`);
