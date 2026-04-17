import { NextResponse } from 'next/server';
import { createClient, createAdminSupabaseClient } from '@/lib/supabase/server';
import { getPool, type VehicleRowPacket } from '@/lib/aurora';
import { decodeVin } from '@/lib/vinquery';
import { generateVehicleContent } from '@/lib/ai-content';
import { parseOptions, vehicleCondition } from '@/lib/vehicles';

export async function GET(request: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const vin = searchParams.get('vin')?.trim().toUpperCase();
  const dealerId = searchParams.get('dealer_id')?.trim();

  if (!vin || !dealerId) {
    return NextResponse.json({ error: 'vin and dealer_id are required' }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // 1. Check cache
  const { data: cached } = await admin
    .from('ai_content_cache')
    .select('description, features, generated_at, model_version')
    .eq('vin', vin)
    .eq('dealer_id', dealerId)
    .single();

  if (cached?.description) {
    return NextResponse.json({
      description: cached.description,
      features: cached.features ?? [],
      source: 'cache',
      generated_at: cached.generated_at,
      model_version: cached.model_version,
    });
  }

  // 2. Check dealer's AI content default setting
  const { data: settings } = await admin
    .from('dealer_settings')
    .select('ai_content_default')
    .eq('dealer_id', dealerId)
    .single();

  if (!settings?.ai_content_default) {
    return NextResponse.json({ description: null, features: null, source: 'db' });
  }

  // 3. Generate fresh content
  const content = await generateContent(vin, dealerId);
  if (!content) {
    return NextResponse.json({ description: null, features: null, source: 'db' });
  }

  // 4. Cache it
  await admin.from('ai_content_cache').upsert({
    vin,
    dealer_id: dealerId,
    description: content.description,
    features: content.features,
    generated_at: new Date().toISOString(),
    model_version: content.modelVersion,
  }, { onConflict: 'vin,dealer_id' });

  return NextResponse.json({
    description: content.description,
    features: content.features,
    source: 'generated',
    model_version: content.modelVersion,
  });
}

async function generateContent(vin: string, dealerId: string) {
  try {
    // Fetch vehicle from Aurora
    const pool = getPool();
    const [rows] = await pool.execute<VehicleRowPacket[]>(
      `SELECT VIN_NUMBER, YEAR, MAKE, MODEL, TRIM, EXT_COLOR, MILEAGE, MSRP,
              NEW_USED, CERTIFIED, OPTIONS
       FROM dealer_inventory
       WHERE VIN_NUMBER = ? AND DEALER_ID = ? LIMIT 1`,
      [vin, dealerId]
    );
    const row = rows[0];

    const vehicleInput = {
      year: row?.YEAR,
      make: row?.MAKE,
      model: row?.MODEL,
      trim: row?.TRIM,
      colorExt: row?.EXT_COLOR,
      mileage: row?.MILEAGE,
      condition: row ? vehicleCondition(row) : undefined,
      options: row?.OPTIONS ? parseOptions(row.OPTIONS) : [],
      msrp: row?.MSRP ? Number(row.MSRP) : null,
    };

    // Enrich with VINQuery if key is configured
    const vinData = await decodeVin(vin);

    return await generateVehicleContent(vehicleInput, vinData);
  } catch {
    return null;
  }
}
