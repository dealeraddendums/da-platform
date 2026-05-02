import { NextResponse } from 'next/server';
import { createClient, createAdminSupabaseClient } from '@/lib/supabase/server';
import { decodeVin } from '@/lib/vinquery';
import { generateVehicleContent } from '@/lib/ai-content';
import { vehicleCondition } from '@/lib/vehicles';
import type { VehicleRow } from '@/lib/vehicles';

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
    const admin = createAdminSupabaseClient();

    // Fetch vehicle from Supabase dealer_vehicles
    const { data: row } = await admin
      .from('dealer_vehicles')
      .select('year, make, model, trim, exterior_color, mileage, msrp, condition')
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

    const vinData = await decodeVin(vin);
    const content = await generateVehicleContent(vehicleInput, vinData);

    // Upsert cache
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
