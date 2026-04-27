// Server-only. Manages Buyer's Guide PDF backgrounds in Supabase Storage.
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { createAdminSupabaseClient } from '@/lib/db';
import { type BgKey, BG_KEYS } from '@/lib/buyers-guide-constants';

export type { BgKey } from '@/lib/buyers-guide-constants';
export { BG_KEYS, BG_LABELS } from '@/lib/buyers-guide-constants';

const BUCKET = 'buyers-guide-pdfs';

async function extractFromLocal(key: BgKey): Promise<Buffer> {
  const lang = key.startsWith('spanish') ? 'es' : 'en';
  const frontIdx = key.includes('implied') ? 1 : 0;
  const filename = lang === 'es' ? 'es.pdf' : 'en.pdf';

  const srcPath = path.join(process.cwd(), 'assets', 'buyers-guide', filename);
  const srcBuf = fs.readFileSync(srcPath);
  const srcDoc = await PDFDocument.load(srcBuf);

  const outDoc = await PDFDocument.create();
  const [front, back] = await outDoc.copyPages(srcDoc, [frontIdx, 2]);
  outDoc.addPage(front);
  outDoc.addPage(back);

  return Buffer.from(await outDoc.save());
}

async function ensureBucket(): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { data: buckets } = await admin.storage.listBuckets();
  if (!buckets?.some(b => b.name === BUCKET)) {
    await admin.storage.createBucket(BUCKET, { public: false });
  }
}

export async function getBuyersGuidePdfBytes(key: BgKey, dealerUuid?: string | null): Promise<Buffer> {
  const admin = createAdminSupabaseClient();

  if (dealerUuid) {
    const { data } = await admin.storage.from(BUCKET).download(`dealers/${dealerUuid}/${key}.pdf`);
    if (data) return Buffer.from(await data.arrayBuffer());
  }

  const { data: sysData } = await admin.storage.from(BUCKET).download(`system/${key}.pdf`);
  if (sysData) return Buffer.from(await sysData.arrayBuffer());

  return extractFromLocal(key);
}

export async function seedSystemPdf(key: BgKey): Promise<void> {
  await ensureBucket();
  const admin = createAdminSupabaseClient();
  const buf = await extractFromLocal(key);
  await admin.storage.from(BUCKET).upload(`system/${key}.pdf`, buf, {
    contentType: 'application/pdf',
    upsert: true,
  });
}

export async function uploadSystemPdf(key: BgKey, buffer: Buffer): Promise<void> {
  await ensureBucket();
  const admin = createAdminSupabaseClient();
  await admin.storage.from(BUCKET).upload(`system/${key}.pdf`, buffer, {
    contentType: 'application/pdf',
    upsert: true,
  });
}

export async function uploadDealerPdf(dealerUuid: string, key: BgKey, buffer: Buffer): Promise<void> {
  await ensureBucket();
  const admin = createAdminSupabaseClient();
  await admin.storage.from(BUCKET).upload(`dealers/${dealerUuid}/${key}.pdf`, buffer, {
    contentType: 'application/pdf',
    upsert: true,
  });
}

export async function deleteDealerPdf(dealerUuid: string, key: BgKey): Promise<void> {
  const admin = createAdminSupabaseClient();
  await admin.storage.from(BUCKET).remove([`dealers/${dealerUuid}/${key}.pdf`]);
}

export async function getSystemPdfSignedUrl(key: BgKey): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(`system/${key}.pdf`, 3600);
  return data?.signedUrl ?? null;
}

export async function getDealerPdfSignedUrl(dealerUuid: string, key: BgKey): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(`dealers/${dealerUuid}/${key}.pdf`, 3600);
  return data?.signedUrl ?? null;
}

export async function checkSystemPdfExists(key: BgKey): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.storage.from(BUCKET).list('system');
  return (data ?? []).some(f => f.name === `${key}.pdf`);
}

export async function checkDealerPdfExists(dealerUuid: string, key: BgKey): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.storage.from(BUCKET).list(`dealers/${dealerUuid}`);
  return (data ?? []).some(f => f.name === `${key}.pdf`);
}
