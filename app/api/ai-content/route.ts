import { NextResponse } from 'next/server';
import { createClient, createAdminSupabaseClient } from '@/lib/supabase/server';
import { decodeVin } from '@/lib/vinquery';
import { generateVehicleContent } from '@/lib/ai-content';
import { vehicleCondition } from '@/lib/vehicles';
import type { VehicleRow } from '@/lib/vehicles';

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
  const content = await generateContent(vin, dealerId, admin);
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

async function generateContent(
  vin: string,
  dealerId: string,
  admin: ReturnType<typeof createAdminSupabaseClient>
) {
  try {
    // Fetch vehicle from Supabase dealer_vehicles
    const { data: row } = await admin
      .from('dealer_vehicles')
      .select('year, make, model, trim, exterior_color, mileage, msrp, condition, description')
      .eq('vin', vin)
      .eq('dealer_id', dealerId)
      .maybeSingle();

    const vehicleRow: Partial<VehicleRow> = row
      ? {
          YEAR: row.year ? String(row.year) : null,
          MAKE: row.make ?? null,
          MODEL: row.model ?? null,
          TRIM: row.trim ?? null,
          EXT_COLOR: row.exterior_color ?? null,
          MILEAGE: row.mileage ? String(row.mileage) : null,
          MSRP: row.msrp ? String(row.msrp) : null,
          NEW_USED: row.condition === 'Used' ? 'Used' : 'New',
          CERTIFIED: row.condition === 'CPO' ? 'Yes' : 'No',
        }
      : {};

    const vehicleInput = {
      year: vehicleRow.YEAR ?? undefined,
      make: vehicleRow.MAKE ?? undefined,
      model: vehicleRow.MODEL ?? undefined,
      trim: vehicleRow.TRIM ?? undefined,
      colorExt: vehicleRow.EXT_COLOR ?? undefined,
      mileage: vehicleRow.MILEAGE ?? undefined,
      condition: row ? vehicleCondition(vehicleRow as VehicleRow) : undefined,
      options: [],
      msrp: vehicleRow.MSRP ? Number(vehicleRow.MSRP) : null,
    };

    // Enrich with VINQuery if key is configured
    const vinData = await decodeVin(vin);

    return await generateVehicleContent(vehicleInput, vinData);
  } catch {
    return null;
  }
}
