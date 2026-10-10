import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { requireAuth } from '@/lib/auth';
import { resolveAiContentDealer } from '@/lib/ai-content-scope';
import { decodeVin } from '@/lib/vinquery';
import { generateVehicleContent } from '@/lib/ai-content';
import { vehicleCondition, vehicleConditionFields } from '@/lib/vehicles';
import type { VehicleRow } from '@/lib/vehicles';

export async function POST(request: Request) {
  const { claims, error } = await requireAuth();
  if (error) return error;
  // The dealer is the SESSION's (lib/ai-content-scope.ts). A dealer_id in the
  // body is ignored — it used to be trusted, letting any user overwrite any
  // dealer's cached AI content.
  const scope = await resolveAiContentDealer(claims);
  if (!scope.ok) return scope.response;
  const dealerId = scope.dealerId;

  const body = await request.json().catch(() => ({})) as { vin?: string };
  const vin = body.vin?.trim().toUpperCase();
  if (!vin) {
    return NextResponse.json({ error: 'vin is required' }, { status: 400 });
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

    // Regenerate is for a vehicle this dealer actually has (the Builder's
    // vehicle preview) — no writing cache rows for arbitrary VINs.
    if (!row) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });

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
          CERTIFIED: vehicleConditionFields(row).CERTIFIED,
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
