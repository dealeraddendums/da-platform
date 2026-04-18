// Server-only: VIN decode with fallback chain.
// Import only from API routes and server components.

import { createAdminSupabaseClient } from './db';
import { getPool } from './aurora';
import type { RowDataPacket } from 'mysql2/promise';

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
  source: 'override' | 'nhtsa' | 'dealer_vehicles' | 'aurora' | 'partial';
  decode_flagged: boolean;
  confidence: 'high' | 'medium' | 'low';
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
      source: 'nhtsa',
      decode_flagged: false,
      confidence: 'high',
    };
  } catch {
    return null;
  }
}

export async function decodeVin(vin: string): Promise<DecodeResult> {
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
        source: 'override',
        decode_flagged: false,
        confidence: 'high',
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
      source: 'nhtsa',
      decode_flagged: false,
      confidence: 'high',
    };
  }

  // Live NHTSA API (populates local cache on next sync)
  const nhtsa = await liveNhtsaDecode(vinUpper);
  if (nhtsa) return nhtsa;

  // ── Step 3: dealer_vehicles Supabase ─────────────────────────────────────
  const { data: dvRow } = await admin
    .from('dealer_vehicles')
    .select('year,make,model,trim,body_style,engine,transmission,drivetrain')
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
      source: 'dealer_vehicles',
      decode_flagged: true,
      confidence: 'medium',
    };
  }

  // ── Step 4: Aurora legacy inventory ───────────────────────────────────────
  // TODO: REMOVE AFTER AURORA MIGRATION COMPLETE
  try {
    type ARow = RowDataPacket & {
      YEAR: string; MAKE: string; MODEL: string; TRIM: string;
      BODYSTYLE: string; ENGINE: string; TRANSMISSION: string; DRIVETRAIN: string;
    };
    const pool = getPool();
    const [rows] = await pool.execute<ARow[]>(
      'SELECT YEAR, MAKE, MODEL, TRIM, BODYSTYLE, ENGINE, TRANSMISSION, DRIVETRAIN FROM vehicles WHERE VIN_NUMBER = ? LIMIT 1',
      [vinUpper]
    );
    const row = rows[0];
    if (row?.MAKE) {
      return {
        vin: vinUpper,
        year: row.YEAR ? parseInt(row.YEAR, 10) : null,
        make: row.MAKE || null,
        model: row.MODEL || null,
        trim: row.TRIM || null,
        body_style: row.BODYSTYLE || null,
        engine: row.ENGINE || null,
        transmission: row.TRANSMISSION || null,
        drivetrain: row.DRIVETRAIN || null,
        fuel_type: null,
        doors: null,
        source: 'aurora',
        decode_flagged: true,
        confidence: 'medium',
      };
    }
  } catch {
    // Aurora unavailable — continue
  }

  // ── Step 5: WMI partial decode ────────────────────────────────────────────
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
      fuel_type: null, doors: null,
      source: 'partial', decode_flagged: true, confidence: 'low',
    };
  }

  // Nothing found
  return {
    vin: vinUpper, year: null, make: null, model: null,
    trim: null, body_style: null, engine: null,
    transmission: null, drivetrain: null, fuel_type: null, doors: null,
    source: 'partial', decode_flagged: true, confidence: 'low',
  };
}
