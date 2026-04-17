import { NextResponse } from 'next/server';
import { createClient, createAdminSupabaseClient } from '@/lib/supabase/server';
import { getPool, type VehicleRowPacket } from '@/lib/aurora';
import { decodeVin } from '@/lib/vinquery';
import { generateVehicleContent } from '@/lib/ai-content';
import { parseOptions, vehicleCondition } from '@/lib/vehicles';

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json() as { vin?: string; dealer_id?: string };
  const vin = body.vin?.trim().toUpperCase();
  const dealerId = body.dealer_id?.trim();

  if (!vin || !dealerId) {
    return NextResponse.json({ error: 'vin and dealer_id are required' }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'AI content not configured' }, { status: 503 });
  }

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

    const vinData = await decodeVin(vin);
    const content = await generateVehicleContent(vehicleInput, vinData);

    // Upsert cache
    const admin = createAdminSupabaseClient();
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
      source: 'regenerated',
      model_version: content.modelVersion,
    });
  } catch (err) {
    console.error('AI regenerate error:', err);
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
  }
}
