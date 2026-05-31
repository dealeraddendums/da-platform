// Server-only: upload PDF buffer to S3 and return a 24-hour signed URL.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = 'dealer-addendums';
const LOGO_BUCKET = 'new-dealer-logos';
const LOGO_BASE_URL = 'https://new-dealer-logos.s3.us-east-1.amazonaws.com';

export type PdfDocType = 'addendum' | 'infosheet' | 'buyer_guide';

/**
 * Canonical per-vehicle PDF key. Dealer website integrations rely on this
 * format being stable: addendum is the bare {VIN}.pdf slot, infosheet and
 * buyer's guide get suffixed siblings. Falls back to vehicle UUID for the
 * filename when VIN is missing so we never produce an empty path segment.
 */
export function buildPdfKey(opts: {
  internalId: string | number | null | undefined;
  dealerIdFallback: string;
  vehicleUuid: string;
  vin: string | null | undefined;
  docType: PdfDocType;
}): string {
  // Flat, VIN-named key at the bucket root. Addendum is the bare {VIN}.pdf
  // slot; infosheet / buyer's guide get suffixed siblings. Uppercased to
  // match the dealer-website lookup in lib/addendum.ts (checkPdfExists HEADs
  // `${BUCKET}/${vin.toUpperCase()}.pdf`) — S3 keys are case-sensitive, so
  // storage and lookup must agree. Reprints reuse the same key and overwrite
  // in place (no per-print timestamps, no nested folders). Falls back to the
  // vehicle UUID when VIN is missing so we never emit an empty filename.
  // internalId / dealerIdFallback stay in the signature for callers but are
  // no longer part of the key.
  const vinTrimmed = opts.vin?.trim();
  const filename = vinTrimmed && vinTrimmed.length > 0 ? vinTrimmed.toUpperCase() : opts.vehicleUuid;
  const suffix = opts.docType === 'infosheet' ? '_infosheet'
    : opts.docType === 'buyer_guide' ? '_buyers_guide'
    : '';
  return `${filename}${suffix}.pdf`;
}

function getClient(): S3Client {
  return new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

/**
 * @param buffer  PDF bytes
 * @param key     S3 key (flat `{VIN}.pdf` convention)
 * @param opts.docType  Optional. Tags the object with `doc_type=<value>`
 *   so the bucket's lifecycle rule applies the right TTL:
 *     "addendum"     → 180 days
 *     "infosheet"    → 1 day
 *     "buyer_guide"  → 1 day
 *     "bulk_merged"  → 1 day
 *   Omitting the tag leaves the object untagged — the lifecycle rules
 *   above won't match, so the object will live indefinitely. ALWAYS
 *   pass a docType unless you genuinely want permanent retention.
 */
export async function uploadPdf(
  buffer: Buffer,
  key: string,
  opts: { docType?: 'addendum' | 'infosheet' | 'buyer_guide' | 'bulk_merged' } = {},
): Promise<string> {
  const s3 = new S3Client({
    region: 'us-west-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  const params: ConstructorParameters<typeof PutObjectCommand>[0] = {
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  };
  if (opts.docType) {
    params.Tagging = `doc_type=${opts.docType}`;
  }
  await s3.send(new PutObjectCommand(params));
  return signPdfKey(key);
}

/**
 * Produce a 24-hour signed GET URL for an existing key in the
 * dealer-addendums bucket. Used by the bulk service path: the PDF
 * service already uploaded the per-vehicle PDF, da-platform just needs
 * a URL to store in print_history.pdf_url with the same TTL the local
 * uploadPdf path produces, so dealer-website integrations see a
 * consistent URL shape regardless of which code path generated it.
 */
export async function signPdfKey(key: string): Promise<string> {
  const s3 = new S3Client({
    region: 'us-west-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: 86_400 },
  );
}

export async function uploadBackground(buffer: Buffer, key: string): Promise<string> {
  const s3 = getClient();
  await s3.send(new PutObjectCommand({
    Bucket: 'new-addendum-backgrounds',
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
  }));
  return `https://new-addendum-backgrounds.s3.us-east-1.amazonaws.com/${key}`;
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
