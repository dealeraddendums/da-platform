import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const BUCKET = "addendum-product-images";
const REGION = process.env.AWS_REGION || "us-east-1";

function getClient() {
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

export async function GET(): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const s3 = getClient();
  const result = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));

  const images = (result.Contents ?? [])
    .filter(obj => obj.Key && /\.(png|jpg|jpeg|gif|webp)$/i.test(obj.Key))
    .map(obj => ({
      key: obj.Key!,
      url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${obj.Key!}`,
      size: obj.Size,
      lastModified: obj.LastModified,
    }));

  return NextResponse.json({ images });
}
