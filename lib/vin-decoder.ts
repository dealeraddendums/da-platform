// Server-only: VIN decode with fallback chain.
// Import only from API routes and server components.

import { createAdminSupabaseClient } from './db';

export type DecodeResult = {
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  body_style: string | null;
  engine: string | null;
  transmission: string | null;
  drivetrain: string | null;
  fuel_type: string | null;
  doors: number | null;
  cmpg: string | null;
  hmpg: string | null;
  source: 'override' | 'nhtsa' | 'dealer_vehicles' | 'partial';
  decode_flagged: boolean;
  confidence: 'high' | 'medium' | 'low';
  /**
   * Granular resolution stage for usage logging (migration 151). `source` is
   * coarser ('nhtsa' = pattern OR live vPIC, 'partial' = WMI hit OR nothing)
   * and is consumed by dealer_vehicles.decode_source / the Flagged tab, so it
   * stays untouched.
   */
  resolved_by: 'override' | 'pattern' | 'vpic' | 'dealer_vehicles' | 'wmi_partial' | 'failed';
};

function buildEngine(raw: Record<string, string>): string | null {
  const cyl = raw.EngineCylinders;
  const disp = raw['DisplacementL'] ? parseFloat(raw['DisplacementL']).toFixed(1) + 'L' : null;
  const parts = [cyl ? `${cyl}-cyl` : null, disp].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// Step 2a: live NHTSA vPIC API — called when local DB has no match
async function liveNhtsaDecode(vin: string): Promise<DecodeResult | null> {
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValues/${encodeURIComponent(vin)}?format=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const json = await res.json() as { Results: Record<string, string>[]; Count: number };
    const raw = json.Results?.[0];
    if (!raw || raw.ErrorCode !== '0') return null;
    if (!raw.Make && !raw.ModelYear) return null;
    return {
      vin,
      year: raw.ModelYear ? parseInt(raw.ModelYear, 10) : null,
      make: raw.Make || null,
      model: raw.Model || null,
      trim: raw.Trim || null,
      body_style: raw.BodyClass || null,
      engine: buildEngine(raw),
      transmission: raw.TransmissionStyle || null,
      drivetrain: raw.DriveType || null,
      fuel_type: raw.FuelTypePrimary || null,
      doors: raw.Doors ? parseInt(raw.Doors, 10) : null,
      cmpg: null,
      hmpg: null,
      source: 'nhtsa',
      decode_flagged: false,
      confidence: 'high',
      resolved_by: 'vpic',
    };
  } catch {
    return null;
  }
}

// Best-effort MPG enrichment from the platform's own inventory. Supplier feeds
// populate dealer_vehicles.cmpg/hmpg, so an internal row is a reliable source —
// no external EPA dependency. Never throws.
//
// Match precedence:
//   1. Same VIN — literally the same vehicle, so MPG is exact and always safe.
//   2. Trim-exact fallback — year + make + model + TRIM must all match (case/
//      whitespace-normalized), and engine + drivetrain must match too when BOTH
//      the decoded result and the candidate carry them. MPG varies by trim/
//      engine/drivetrain, so a looser year/make/model match could copy the wrong
//      variant onto a consumer-facing infosheet.
//   3. No confident match (incl. trim missing on either side) → leave BLANK.
//      Manual entry fills the gap (per spec).
const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

async function enrichMpgFromInventory(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  vinUpper: string,
  decoded: DecodeResult,
): Promise<{ cmpg: string | null; hmpg: string | null }> {
  try {
    // 1. Same-VIN match — same vehicle, always safe.
    const { data: byVin } = await admin
      .from('dealer_vehicles')
      .select('cmpg,hmpg')
      .eq('vin', vinUpper)
      .not('cmpg', 'is', null)
      .limit(1)
      .maybeSingle();
    if (byVin?.cmpg) return { cmpg: byVin.cmpg, hmpg: byVin.hmpg ?? null };

    // 2. Trim-exact fallback. Require year + make + model + trim; bail otherwise.
    const dTrim = norm(decoded.trim);
    if (!decoded.year || !decoded.make || !decoded.model || !dTrim) {
      return { cmpg: null, hmpg: null };
    }

    const { data: cands } = await admin
      .from('dealer_vehicles')
      .select('cmpg,hmpg,trim,engine,drivetrain')
      .eq('year', decoded.year)
      .ilike('make', decoded.make)
      .ilike('model', decoded.model)
      .not('cmpg', 'is', null)
      .limit(50);
    if (!cands?.length) return { cmpg: null, hmpg: null };

    const dEngine = norm(decoded.engine);
    const dDrive = norm(decoded.drivetrain);
    for (const c of cands) {
      // Trim must match and be present on both sides.
      if (norm(c.trim) !== dTrim) continue;
      // Engine / drivetrain must match only when both rows carry the field.
      const cEngine = norm(c.engine);
      if (dEngine && cEngine && dEngine !== cEngine) continue;
      const cDrive = norm(c.drivetrain);
      if (dDrive && cDrive && dDrive !== cDrive) continue;
      return { cmpg: c.cmpg, hmpg: c.hmpg ?? null };
    }
  } catch { /* best-effort — leave blank, manual entry fills the gap */ }
  return { cmpg: null, hmpg: null };
}

export async function decodeVin(vin: string): Promise<DecodeResult> {
  const vinUpper = vin.toUpperCase();
  const result = await resolveVin(vinUpper);
  // Enrich MPG when the primary decode didn't supply it.
  if (result.cmpg == null || result.hmpg == null) {
    const admin = createAdminSupabaseClient();
    const mpg = await enrichMpgFromInventory(admin, vinUpper, result);
    if (result.cmpg == null) result.cmpg = mpg.cmpg;
    if (result.hmpg == null) result.hmpg = mpg.hmpg;
  }
  return result;
}

async function resolveVin(vin: string): Promise<DecodeResult> {
  const admin = createAdminSupabaseClient();
  const vinUpper = vin.toUpperCase();

  // ── Step 1: Admin overrides (highest priority) ────────────────────────────
  const { data: overrides } = await admin
    .from('nhtsa_overrides')
    .select('*')
    .limit(500);

  if (overrides?.length) {
    let best: typeof overrides[0] | null = null;
    let bestLen = 0;
    for (const o of overrides) {
      const pfx = o.vin_prefix.toUpperCase();
      if (vinUpper.startsWith(pfx) && pfx.length > bestLen) {
        best = o;
        bestLen = pfx.length;
      }
    }
    if (best) {
      return {
        vin: vinUpper,
        year: best.year,
        make: best.make,
        model: best.model,
        trim: best.trim,
        body_style: best.body_style,
        engine: best.engine,
        transmission: best.transmission,
        drivetrain: best.drivetrain,
        fuel_type: null,
        doors: null,
        cmpg: null,
        hmpg: null,
        source: 'override',
        decode_flagged: false,
        confidence: 'high',
        resolved_by: 'override',
      };
    }
  }

  // ── Step 2: NHTSA vPIC local DB + live API fallback ───────────────────────
  // Try local nhtsa_vin_patterns first (populated by sync script over time)
  const { data: patterns } = await admin
    .from('nhtsa_vin_patterns')
    .select('*')
    .eq('pattern', vinUpper.substring(0, 9))
    .limit(1);

  if (patterns?.length) {
    const p = patterns[0];
    // Look up names from related tables
    const [makeRes, modelRes] = await Promise.all([
      p.make_id ? admin.from('nhtsa_makes').select('name').eq('id', p.make_id).maybeSingle() : null,
      p.model_id ? admin.from('nhtsa_models').select('name').eq('id', p.model_id).maybeSingle() : null,
    ]);
    return {
      vin: vinUpper,
      year: p.model_year,
      make: makeRes?.data?.name ?? null,
      model: modelRes?.data?.name ?? null,
      trim: null,
      body_style: null,
      engine: p.engine,
      transmission: p.transmission,
      drivetrain: p.drivetrain,
      fuel_type: p.fuel_type,
      doors: p.doors,
      cmpg: null,
      hmpg: null,
      source: 'nhtsa',
      decode_flagged: false,
      confidence: 'high',
      resolved_by: 'pattern',
    };
  }

  // Live NHTSA API (populates local cache on next sync)
  const nhtsa = await liveNhtsaDecode(vinUpper);
  if (nhtsa) return nhtsa;

  // ── Step 3: dealer_vehicles Supabase ─────────────────────────────────────
  const { data: dvRow } = await admin
    .from('dealer_vehicles')
    .select('year,make,model,trim,body_style,engine,transmission,drivetrain,cmpg,hmpg')
    .eq('vin', vinUpper)
    .not('make', 'is', null)
    .limit(1)
    .maybeSingle();

  if (dvRow) {
    return {
      vin: vinUpper,
      year: dvRow.year,
      make: dvRow.make,
      model: dvRow.model,
      trim: dvRow.trim,
      body_style: dvRow.body_style,
      engine: dvRow.engine,
      transmission: dvRow.transmission,
      drivetrain: dvRow.drivetrain,
      fuel_type: null,
      doors: null,
      cmpg: dvRow.cmpg ?? null,
      hmpg: dvRow.hmpg ?? null,
      source: 'dealer_vehicles',
      decode_flagged: true,
      confidence: 'medium',
      resolved_by: 'dealer_vehicles',
    };
  }

  // ── Step 4: WMI partial decode ────────────────────────────────────────────
  const wmi = vinUpper.substring(0, 3);
  const { data: wmiRow } = await admin
    .from('nhtsa_wmi')
    .select('manufacturer_name, make_id')
    .eq('wmi', wmi)
    .maybeSingle();

  if (wmiRow) {
    let makeName = wmiRow.manufacturer_name ?? null;
    if (wmiRow.make_id) {
      const { data: makeRow } = await admin.from('nhtsa_makes').select('name').eq('id', wmiRow.make_id).maybeSingle();
      if (makeRow?.name) makeName = makeRow.name;
    }
    return {
      vin: vinUpper, year: null, make: makeName,
      model: null, trim: null, body_style: null,
      engine: null, transmission: null, drivetrain: null,
      fuel_type: null, doors: null, cmpg: null, hmpg: null,
      source: 'partial', decode_flagged: true, confidence: 'low', resolved_by: 'wmi_partial',
    };
  }

  // Nothing found
  return {
    vin: vinUpper, year: null, make: null, model: null,
    trim: null, body_style: null, engine: null,
    transmission: null, drivetrain: null, fuel_type: null, doors: null,
    cmpg: null, hmpg: null,
    source: 'partial', decode_flagged: true, confidence: 'low', resolved_by: 'failed',
  };
}
