/**
 * Emit idempotent SQL that upserts the Image Builder starter templates
 * (lib/image-builder/starter-templates.ts) as global image_designs rows, plus a
 * v1 version row each. One statement per line — apply each separately (the
 * Supabase Management API silently no-ops multi-statement bodies).
 *   npx tsx scripts/seed-image-builder-templates.ts > seed.sql
 *
 * Re-running refreshes template design_json in place; user designs are never
 * touched (the upsert is keyed on the fixed template ids, is_template = true).
 */
import { STARTER_TEMPLATES } from "../lib/image-builder/starter-templates";
import { validateDesign } from "../lib/image-builder/spec";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
for (const t of STARTER_TEMPLATES) {
  const bad = validateDesign(t.design_json);
  if (bad) throw new Error(`${t.name}: ${bad}`);
  const json = q(JSON.stringify(t.design_json));
  console.log(
    `INSERT INTO public.image_designs (id, dealer_uuid, image_type, name, design_json, is_template) VALUES (${q(t.id)}, NULL, ${q(t.image_type)}, ${q(t.name)}, ${json}::jsonb, true) ` +
    `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_type = EXCLUDED.image_type, design_json = EXCLUDED.design_json, updated_at = now() WHERE public.image_designs.is_template;`,
  );
  console.log(
    `INSERT INTO public.image_design_versions (design_id, version_no, design_json) VALUES (${q(t.id)}, 1, ${json}::jsonb) ON CONFLICT (design_id, version_no) DO NOTHING;`,
  );
}
