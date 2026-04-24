// Server-only: upload PDF buffer to S3 and return a 24-hour signed URL.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = 'dealer-addendums';
const LOGO_BUCKET = 'new-dealer-logos';
const LOGO_BASE_URL = 'https://new-dealer-logos.s3.us-east-1.amazonaws.com';

function getClient(): S3Client {
  return new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

export async function uploadPdf(buffer: Buffer, key: string): Promise<string> {
  const s3 = new S3Client({
    region: 'us-west-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  }));
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: 86_400 },
  );
}

export async function uploadLogo(buffer: Buffer, key: string, contentType: string): Promise<string> {
  const s3 = getClient();
  await s3.send(new PutObjectCommand({
    Bucket: LOGO_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${LOGO_BASE_URL}/${key}`;
}
