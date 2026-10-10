// AI vehicle description for the INFOSHEET (2026-10-09, migration 173).
//
// Two things live here so the Edit Vehicle "Generate" button and the print-time
// auto-generation can never disagree:
//   • effectiveDescriptionModifiers() — the dealer's "house rules": its group's
//     default lines (unless the dealer chose "Don't apply my group's defaults")
//     followed by the dealer's own lines (dealer lines LAST, so they win a
//     conflict). Always resolved server-side from the dealer row — modifier
//     text is never accepted from a client.
//   • modifierPromptBlock() — how those lines are put to the model, with the
//     truthfulness guard: modifiers steer tone/emphasis/inclusions; the model
//     may state a non-vehicle claim only when a modifier explicitly says to,
//     and never invents vehicle specs.
// Product/option descriptions ("✦ Generate" on products) are NOT this path.

import Anthropic from "@anthropic-ai/sdk";
import type { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleInput } from "@/lib/ai-content";
import { resolveVehicleCondition } from "@/lib/vehicles";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/**
 * THE no-unsupported-claims rule for every AI vehicle description — the Edit
 * Vehicle generator below AND the automatic infosheet description
 * (generateVehicleContent in lib/ai-content.ts, which also backs the Builder
 * preview and the Add Vehicle AI fill). One string so no path can drift.
 *
 * An infosheet is a document the dealer stands behind, so this is a
 * compliance rule, not a tone preference (2026-10-10, Allan): the model may
 * assert only what the vehicle data or the dealer's own house rules state.
 * Warranty, condition-quality, history and ranking claims are fabrications
 * the model has no data for. A house rule is the dealer's own assertion and
 * may authorize a statement (e.g. "Mention Free Carfax for used vehicles").
 */
export const NO_UNSUPPORTED_CLAIMS =
  `FACTS ONLY. State only facts that appear in the vehicle data above (year, make, model, trim, body style, colors, mileage, MSRP, engine, transmission, drivetrain, fuel, MPG, listed options/features, and the stated condition New / Used / Certified Pre-Owned) or that a dealership house rule explicitly tells you to state. Do not state or imply anything else, however it is phrased. In particular, NEVER write any of the following unless the vehicle data or a house rule explicitly provides it:
- Warranty or coverage of any kind — "warranty remaining", "years of coverage", "covered until", "factory warranty", "CPO warranty", "peace of mind". "Certified Pre-Owned" may be stated as the condition, but say nothing about what certification includes.
- Condition quality — "like-new", "pristine", "mint", "excellent condition", "great shape", "well-maintained", "well cared for", "garage-kept", "one-owner", "accident-free", "clean history", "clean title". Low mileage may be stated as the number; do not turn it into a condition claim.
- Maintenance, service, ownership or usage history — service records, prior owners, how it was driven or stored.
- Rankings, popularity, awards or superlatives — "best-selling", "#1", "award-winning", "top-rated", "most reliable", "most popular", "proven", "trusted", "legendary", "best-in-class", "industry-leading", "unmatched".
- Reliability, durability, safety or performance claims — no promises about how long it lasts or how safe it is, and no horsepower, torque, 0-60, towing, MPG or range figures that are not in the data above.
- Price, savings, value or deal claims — "great value", "priced to sell", "below market", "save", discounts or incentives. The MSRP may be stated only if it is in the data above.
- Features, packages or technology that are not listed.
Do not use these words unless the exact word appears in the vehicle data or a house rule: legendary, ultimate, iconic, proven, trusted, dependable, reliable, renowned, best-in-class, unmatched, premium, powerful, advanced, luxurious, pristine, immaculate, flawless.
If the data is thin, write a shorter, plain description rather than padding it. Before answering, reread your draft and remove any sentence that is not supported by the vehicle data or a house rule.`;

/** Same model the AI-content route uses (lib/ai-content.ts). */
export const VEHICLE_DESC_MODEL = "claude-haiku-4-5-20251001";
const MAX_MODIFIER_CHARS = 2000;
const MAX_LINES = 25;

export function modifierLines(text: string | null | undefined): string[] {
  return String(text ?? "")
    .slice(0, MAX_MODIFIER_CHARS)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-•*]+/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

export interface EffectiveModifiers {
  groupName: string | null;
  groupLines: string[];      // the group's defaults (shown as inherited even when ignored)
  dealerLines: string[];
  ignoreGroup: boolean;
  lines: string[];           // what generation actually uses
}

export async function effectiveDescriptionModifiers(admin: Admin, dealerTextId: string): Promise<EffectiveModifiers> {
  const a = admin as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [{ data: dealer }, { data: settings }] = await Promise.all([
    a.from("dealers").select("group_id").eq("dealer_id", dealerTextId).maybeSingle(),
    a.from("dealer_settings").select("*").eq("dealer_id", dealerTextId).maybeSingle(),
  ]);
  let groupName: string | null = null;
  let groupLines: string[] = [];
  if (dealer?.group_id) {
    const { data: g } = await a.from("groups").select("*").eq("id", dealer.group_id).maybeSingle();
    groupName = g?.name ?? null;
    groupLines = modifierLines(g?.ai_vehicle_desc_modifiers);
  }
  const dealerLines = modifierLines(settings?.ai_vehicle_desc_modifiers);
  const ignoreGroup = settings?.ai_vehicle_desc_ignore_group === true;
  return { groupName, groupLines, dealerLines, ignoreGroup, lines: [...(ignoreGroup ? [] : groupLines), ...dealerLines] };
}

/**
 * The condition every AI vehicle-description prompt is given, from the
 * dealer_vehicles row (condition + certified flag). Conditional house rules
 * ("Mention Free Carfax for all used vehicles") depend on it, so every
 * generator — Edit Vehicle's Generate AND the print-time auto description —
 * must pass it. CPO is spelled out so "used" rules read naturally against it.
 */
export function aiConditionLabel(v: { condition?: string | null; certified?: string | boolean | null }): "New" | "Used" | "Certified Pre-Owned" {
  const c = resolveVehicleCondition(v);
  return c === "CPO" ? "Certified Pre-Owned" : c;
}

/** The house-rules block appended to a vehicle-description prompt ("" when none). */
export function modifierPromptBlock(lines: string[]): string {
  if (!lines.length) return "";
  return `

The dealership has these house rules for its descriptions. Follow them:
${lines.map((l) => `- ${l}`).join("\n")}

Rules about the house rules: they set tone, length, emphasis and what to include or leave out. You may state something about the dealership (e.g. a rating or that it is family owned) ONLY if a house rule explicitly tells you to. Never invent or guess vehicle specifications, features, history, or pricing that are not in the vehicle data above, even if a house rule seems to ask for it.`;
}

// Different openings so repeated "Generate" clicks give genuinely different drafts.
const ANGLES = [
  "Open with its drivetrain and powertrain from the data.",
  "Open with its practicality for everyday life.",
  "Open with its standout specification from the data.",
  "Open with who this vehicle is a great fit for.",
  "Open with its comfort and interior features, staying within the data.",
  "Open with its body style, color and drivetrain.",
];

export async function generateInfosheetDescription(
  vehicle: VehicleInput & { engine?: string | null; transmission?: string | null; drivetrain?: string | null; fuel?: string | null; bodyStyle?: string | null; interiorColor?: string | null; cmpg?: string | null; hmpg?: string | null },
  lines: string[],
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const name = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
  const facts = [
    vehicle.condition && `Condition: ${vehicle.condition}`,
    vehicle.colorExt && `Exterior color: ${vehicle.colorExt}`,
    vehicle.interiorColor && `Interior color: ${vehicle.interiorColor}`,
    vehicle.mileage && Number(vehicle.mileage) > 0 && `Mileage: ${Number(vehicle.mileage).toLocaleString("en-US")} miles`,
    vehicle.bodyStyle && `Body: ${vehicle.bodyStyle}`,
    vehicle.engine && `Engine: ${vehicle.engine}`,
    vehicle.transmission && `Transmission: ${vehicle.transmission}`,
    vehicle.drivetrain && `Drivetrain: ${vehicle.drivetrain}`,
    vehicle.fuel && `Fuel: ${vehicle.fuel}`,
    vehicle.cmpg && vehicle.hmpg && `MPG: ${vehicle.cmpg} city / ${vehicle.hmpg} hwy`,
    vehicle.options?.length && `Options/packages: ${vehicle.options.slice(0, 15).join(", ")}`,
  ].filter(Boolean).join("\n");
  const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];

  const prompt = `Write the vehicle description for a car dealership's printed information sheet.

Vehicle: ${name || "Vehicle"}
${facts}

Write 2-4 sentences for customers: specific, factual, professional. Use only the vehicle data above. ${angle}
${NO_UNSUPPORTED_CLAIMS}
Do not include a VIN or stock number unless a house rule asks for it. No markdown, no headings, no surrounding quotes.${modifierPromptBlock(lines)}

Return only the description text.`;

  const message = await client.messages.create({
    model: VEHICLE_DESC_MODEL,
    max_tokens: 400,
    temperature: 1,
    messages: [{ role: "user", content: prompt }],
  });
  // Join every text block (newer models can lead with a non-text block).
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text).join("").trim().replace(/^"|"$/g, "");
}
