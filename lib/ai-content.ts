// Server-only: Claude AI content generator for vehicle descriptions and features
// Uses ANTHROPIC_API_KEY from environment (allan@dealeraddendums.com enterprise key)

import Anthropic from '@anthropic-ai/sdk';
import type { VinQueryData } from './vinquery';

export interface AiContent {
  description: string;
  features: [string, string][];
  modelVersion: string;
}

export interface VehicleInput {
  year?: string | number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  colorExt?: string | null;
  mileage?: string | number | null;
  condition?: string;
  options?: string[];
  msrp?: number | null;
}

export async function generateVehicleContent(
  vehicle: VehicleInput,
  vinData: VinQueryData | null
): Promise<AiContent> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Merge dealer_vehicles data with VINQuery enrichment
  const year = vehicle.year ?? vinData?.year ?? '';
  const make = vehicle.make ?? vinData?.make ?? '';
  const model = vehicle.model ?? vinData?.model ?? '';
  const trim = vehicle.trim ?? vinData?.trim ?? '';
  const engine = vinData?.engine ?? '';
  const fuel = vinData?.fuel ?? '';
  const drivetrain = vinData?.drivetrain ?? '';
  const transmission = vinData?.transmission ?? '';
  const bodyStyle = vinData?.bodyStyle ?? '';
  const cylinders = vinData?.cylinders ?? '';
  const horsepower = vinData?.horsepower ?? '';
  const mpgCity = vinData?.mpgCity ?? '';
  const mpgHighway = vinData?.mpgHighway ?? '';

  const vehicleStr = [year, make, model, trim].filter(Boolean).join(' ');
  const colorPart = vehicle.colorExt ? `Exterior color: ${vehicle.colorExt}.` : '';
  const mileagePart = vehicle.mileage
    ? `Mileage: ${Number(vehicle.mileage).toLocaleString()} miles.`
    : '';
  const conditionPart = vehicle.condition ? `Condition: ${vehicle.condition}.` : '';

  const specLines = [
    engine && `Engine: ${engine}`,
    cylinders && `Cylinders: ${cylinders}`,
    horsepower && `Horsepower: ${horsepower} hp`,
    fuel && `Fuel: ${fuel}`,
    drivetrain && `Drivetrain: ${drivetrain}`,
    transmission && `Transmission: ${transmission}`,
    bodyStyle && `Body: ${bodyStyle}`,
    mpgCity && mpgHighway && `MPG: ${mpgCity} city / ${mpgHighway} hwy`,
    vehicle.msrp && `MSRP: $${vehicle.msrp.toLocaleString()}`,
  ].filter(Boolean).join('\n');

  const optionLines = vehicle.options?.length
    ? `Notable options/packages: ${vehicle.options.slice(0, 12).join(', ')}.`
    : '';

  const prompt = `You are writing vehicle listing content for a car dealership's printed information sheet.

Vehicle: ${vehicleStr}
${colorPart} ${mileagePart} ${conditionPart}
${specLines}
${optionLines}

Respond with a single JSON object containing exactly these two keys:
1. "description": A 2-3 sentence compelling vehicle description for customers. Be specific, factual, and professional. Highlight key selling points. No markdown, no quotes around the field value.
2. "features": An array of 10-14 pairs, each pair is [label, value]. Cover: engine/power, transmission, drivetrain, MPG (city/hwy if available), body style, exterior color, mileage (if used/CPO), seating, and 2-3 notable options if provided. Labels should be short (1-3 words). Values should be concise.

Return only raw JSON with no markdown fences or extra text.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = (message.content[0] as { type: string; text: string }).text.trim();
  // Strip markdown fences if present
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed = JSON.parse(json) as { description: string; features: [string, string][] };

  return {
    description: parsed.description ?? '',
    features: (parsed.features ?? []).slice(0, 16),
    modelVersion: 'claude-haiku-4-5-20251001',
  };
}

/**
 * Mileage is a FACT and must come from the database, never the model.
 * The AI feature table both fabricates mileage ("0 miles" printed for a
 * 32,500-mile Kory Hooks vehicle, 2026-08-31) and freezes it: ai_content_cache
 * persists per VIN+dealer and never regenerates as the odometer changes.
 * Enforced at READ time (both pdf routes, right after cache/generation) so
 * stale cached rows are corrected too, and the {{ai.features}} custom-text
 * token inherits the same truth.
 *
 * Any AI row whose label looks like mileage/odometer is REPLACED with the
 * vehicle's real dealer_vehicles mileage; when the DB mileage is absent, 0,
 * or unparseable, the row is DROPPED entirely — a fabricated "0 miles" (or
 * any guessed value) must never print. Duplicate mileage rows collapse to one.
 */
export function enforceDbMileage(
  features: [string, string][] | null | undefined,
  dbMileage: number | string | null | undefined,
): [string, string][] {
  const n = typeof dbMileage === 'number'
    ? dbMileage
    : parseInt(String(dbMileage ?? '').replace(/[^0-9]/g, ''), 10);
  const real = Number.isFinite(n) && n > 0;
  const isMileageLabel = (l: string) => /mileage|odometer/i.test(l) || /^miles$/i.test(l.trim());
  const out: [string, string][] = [];
  let replaced = false;
  for (const row of features ?? []) {
    if (Array.isArray(row) && typeof row[0] === 'string' && isMileageLabel(row[0])) {
      if (real && !replaced) {
        out.push([row[0], `${n.toLocaleString('en-US')} miles`]);
        replaced = true;
      }
      continue; // no real DB mileage, or duplicate row → drop
    }
    out.push(row);
  }
  return out;
}
