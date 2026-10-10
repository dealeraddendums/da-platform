import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { requireAuth } from '@/lib/auth';
import { resolveAiContentDealer } from '@/lib/ai-content-scope';
import { decodeVin } from '@/lib/vinquery';
import { generateVehicleContent } from '@/lib/ai-content';
import { aiConditionLabel, effectiveDescriptionModifiers } from '@/lib/vehicle-description-ai';
import { vehicleConditionFields } from '@/lib/vehicles';
import type { VehicleRow } from '@/lib/vehicles';

export async function GET(request: Request) {
  const { claims, error } = await requireAuth();
  if (error) return error;
  // The dealer is the SESSION's (lib/ai-content-scope.ts); a dealer_id query
  // param is ignored. It used to be trusted — reading another dealer's cached
  // content, and on a cache miss writing a new cache row for that dealer.
  const scope = await resolveAiContentDealer(claims);
  if (!scope.ok) return scope.response;
  const dealerId = scope.dealerId;

  const { searchParams } = new URL(request.url);
  const vin = searchParams.get('vin')?.trim().toUpperCase();
  if (!vin) {
    return NextResponse.json({ error: 'vin is required' }, { status: 400 });
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
      .select('year, make, model, trim, exterior_color, mileage, msrp, condition, certified, description')
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
      condition: row ? aiConditionLabel(row) : undefined,
      options: [],
      msrp: vehicleRow.MSRP ? Number(vehicleRow.MSRP) : null,
    };

    // Enrich with VINQuery if key is configured
    const vinData = await decodeVin(vin);

    return await generateVehicleContent(vehicleInput, vinData,
      // House rules (migration 173): this writes the same ai_content_cache row
      // the infosheet prints, so it must follow them like print-time generation.
      (await effectiveDescriptionModifiers(admin, dealerId)).lines);
  } catch {
    return null;
  }
}
