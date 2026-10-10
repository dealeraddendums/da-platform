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

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/**
 * THE no-unsupported-claims rule for every AI vehicle description — the Edit
 * Vehicle generator below AND the automatic infosheet description
 * (generateVehicleContent in lib/ai-content.ts). One string so the two can't
 * drift. An infosheet is a document the dealer stands behind.
 */
export const NO_UNSUPPORTED_CLAIMS =
  `Do not make claims the data doesn't support — no reliability or durability promises, no "legendary", "best-in-class", "built to exacting standards", no guesses about features, packages or technology that aren't listed. If the data is thin, write a shorter description rather than padding it.`;

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
  "Open with what makes this vehicle enjoyable to drive.",
  "Open with its practicality for everyday life.",
  "Open with its standout specification from the data.",
  "Open with who this vehicle is a great fit for.",
  "Open with its comfort and interior experience, staying within the data.",
  "Open with its value and condition, staying within the data.",
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
