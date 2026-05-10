/**
 * Shared trim-harvest logic. Takes a list of VINs (e.g. all of
 * dealer_vehicles for a backfill, or vehicles added in the last 25 hours
 * for a daily cron), dedupes by VIN squish (positions 0-7 + 9, skipping
 * the position-8 check digit which is the only character that varies for
 * the same vehicle configuration), and decodes the unique squishes via
 * NHTSA's DecodeVINValuesBatch endpoint. Decoded Trim/Series values are
 * upserted into nhtsa_trims keyed by (make_id, model_id, name) using a
 * deterministic FNV-1a hash for the int PK so re-runs are idempotent.
 *
 * Coverage is bounded by what nhtsa_models already knows. The existing
 * sync-nhtsa.ts script seeded models for 44 major makes (~1956 models);
 * any decoded vehicle whose make/model isn't in nhtsa_models is silently
 * skipped (counted in `skippedNoModel`). Run sync-nhtsa.ts first to widen
 * the model catalog if dealer inventory contains makes outside that set.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const NHTSA_BATCH_SIZE = 50;
const BATCH_DELAY_MS = 200;
const NHTSA_BATCH_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function squish(vin: string): string | null {
  const v = vin.trim().toUpperCase();
  if (v.length < 11) return null;
  return v.slice(0, 8) + v.charAt(9);
}

function trimId(modelId: number, name: string): number {
  const s = `${modelId}:${name.toLowerCase().trim()}`;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

interface MakeRow { id: number; name: string }
interface ModelRow { id: number; name: string; make_id: number }

interface DecodeResult {
  VIN?: string;
  Make?: string;
  Model?: string;
  Trim?: string;
  Series?: string;
  ModelYear?: string;
  ErrorCode?: string;
}

interface DecodeResponse {
  Count?: number;
  Results?: DecodeResult[];
}

export interface HarvestStats {
  totalVins: number;
  uniqueSquishes: number;
  decoded: number;
  decodeErrors: number;
  trimRowsUpserted: number;
  skippedNoTrim: number;
  skippedNoModel: number;
  skippedNoMake: number;
  elapsedMs: number;
}

async function decodeBatch(vins: string[]): Promise<DecodeResult[]> {
  try {
    const body = `data=${vins.join(";")}&format=json`;
    const res = await fetch(NHTSA_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as DecodeResponse;
    return json.Results ?? [];
  } catch {
    return [];
  }
}

/**
 * Decodes the given VINs and writes trim/series values to nhtsa_trims.
 * Caller is responsible for fetching VINs from wherever (full backfill
 * vs cron-window slice). onProgress fires every batch so callers can log.
 */
export async function harvestTrimsFromVins(
  sb: SupabaseClient,
  vins: string[],
  onProgress?: (stats: HarvestStats) => void,
): Promise<HarvestStats> {
  const startedAt = Date.now();
  const stats: HarvestStats = {
    totalVins: vins.length,
    uniqueSquishes: 0,
    decoded: 0,
    decodeErrors: 0,
    trimRowsUpserted: 0,
    skippedNoTrim: 0,
    skippedNoModel: 0,
    skippedNoMake: 0,
    elapsedMs: 0,
  };

  // Load make/model catalogs into memory once. PostgREST caps single .range()
  // calls at 1000 rows by default, so paginate explicitly — otherwise common
  // makes like FORD or TOYOTA fall outside the first page and get silently
  // miss-matched as "skippedNoMake".
  const allMakes: MakeRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("nhtsa_makes")
      .select("id, name")
      .order("id", { ascending: true })
      .range(from, from + 999)
      .returns<MakeRow[]>();
    const rows = data ?? [];
    allMakes.push(...rows);
    if (rows.length < 1000) break;
  }
  const allModels: ModelRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("nhtsa_models")
      .select("id, name, make_id")
      .order("id", { ascending: true })
      .range(from, from + 999)
      .returns<ModelRow[]>();
    const rows = data ?? [];
    allModels.push(...rows);
    if (rows.length < 1000) break;
  }

  const makeByName = new Map<string, MakeRow>();
  for (const m of allMakes) makeByName.set(m.name.toLowerCase(), m);

  const modelByMakeAndName = new Map<string, ModelRow>();
  for (const m of allModels) {
    modelByMakeAndName.set(`${m.make_id}:${m.name.toLowerCase()}`, m);
  }

  // Dedupe by squish.
  const uniqueByVinForDecode = new Map<string, string>(); // squish → first VIN seen
  for (const vin of vins) {
    const sq = squish(vin);
    if (!sq) continue;
    if (!uniqueByVinForDecode.has(sq)) uniqueByVinForDecode.set(sq, vin.toUpperCase());
  }
  const vinsToDecode = Array.from(uniqueByVinForDecode.values());
  stats.uniqueSquishes = vinsToDecode.length;

  // Track new (model_id, name) pairs to write at end so we can dedupe.
  const trimRows = new Map<number, { id: number; model_id: number; name: string }>();

  for (let i = 0; i < vinsToDecode.length; i += NHTSA_BATCH_SIZE) {
    const batch = vinsToDecode.slice(i, i + NHTSA_BATCH_SIZE);
    const results = await decodeBatch(batch);

    if (results.length === 0) {
      stats.decodeErrors += batch.length;
    }

    for (const r of results) {
      stats.decoded++;
      const trimRaw = (r.Trim ?? "").trim() || (r.Series ?? "").trim();
      if (!trimRaw) { stats.skippedNoTrim++; continue; }
      const makeName = (r.Make ?? "").trim().toLowerCase();
      const modelName = (r.Model ?? "").trim().toLowerCase();
      if (!makeName) { stats.skippedNoMake++; continue; }
      const make = makeByName.get(makeName);
      if (!make) { stats.skippedNoMake++; continue; }
      if (!modelName) { stats.skippedNoModel++; continue; }
      const model = modelByMakeAndName.get(`${make.id}:${modelName}`);
      if (!model) { stats.skippedNoModel++; continue; }

      const id = trimId(model.id, trimRaw);
      if (!trimRows.has(id)) {
        trimRows.set(id, { id, model_id: model.id, name: trimRaw });
      }
    }

    if (onProgress) {
      stats.elapsedMs = Date.now() - startedAt;
      onProgress({ ...stats, trimRowsUpserted: trimRows.size });
    }

    if (i + NHTSA_BATCH_SIZE < vinsToDecode.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Bulk upsert in chunks of 500.
  const allRows = Array.from(trimRows.values());
  for (let i = 0; i < allRows.length; i += 500) {
    const chunk = allRows.slice(i, i + 500);
    const { error } = await sb.from("nhtsa_trims").upsert(chunk, { onConflict: "id" });
    if (error) {
      console.error(`[trim-harvest] upsert error chunk ${i}: ${error.message}`);
    }
  }
  stats.trimRowsUpserted = allRows.length;
  stats.elapsedMs = Date.now() - startedAt;
  return stats;
}
