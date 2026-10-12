import { NextRequest, NextResponse } from "next/server";
import { requireLogoScope, storeLogo } from "@/lib/logo-studio";
import { sanitizeSvg, SvgSanitizeError } from "@/lib/svg-sanitize";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/logo-studio/save?scope=dealer|group[&group=<uuid>][&dealer=<expected text id>]
 * { svg, name, setAsDealerLogo? }
 *
 * Accepting a Logo Studio preview. The SVG comes back from the browser, so it
 * is untrusted again: it goes through the intake guard HERE, before anything is
 * stored or served, and the PNG is rendered server-side from the sanitized SVG.
 *  • group  → saved to the group's logo library (members see it in the Logo
 *             widget's library and can set it as their dealer logo).
 *  • dealer → saved to the dealer's logo library; with setAsDealerLogo, also
 *             becomes dealers.logo_url — what every Logo widget prints.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const { claims, scope, error } = await requireLogoScope(params, params.get("dealer"));
  if (error) return error;

  const body = await req.json().catch(() => ({})) as { svg?: unknown; name?: unknown; setAsDealerLogo?: unknown };
  if (typeof body.svg !== "string" || !body.svg) return NextResponse.json({ error: "svg required" }, { status: 400 });
  const name = typeof body.name === "string" ? body.name : "";
  const setAsDealerLogo = body.setAsDealerLogo === true;
  if (setAsDealerLogo && scope.kind !== "dealer") return NextResponse.json({ error: "Only a dealership logo can be set here." }, { status: 400 });

  let svg: string;
  try { svg = sanitizeSvg(body.svg).svg; }
  catch (e) {
    if (e instanceof SvgSanitizeError) return NextResponse.json({ error: `That SVG was refused: ${e.message}` }, { status: 422 });
    throw e;
  }

  let saved: Awaited<ReturnType<typeof storeLogo>>;
  try { saved = await storeLogo(scope, svg, name, claims.sub); }
  catch (e) {
    console.error("[logo-studio] save failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't save the logo." }, { status: 500 });
  }

  const db = createAdminSupabaseClient();
  let previousLogo: string | null = null;
  if (setAsDealerLogo && scope.kind === "dealer") {
    const { data: d } = await db.from("dealers").select("logo_url").eq("id", scope.dealerUuid).maybeSingle<{ logo_url: string | null }>();
    previousLogo = d?.logo_url ?? null;
    const { error: upErr } = await db.from("dealers").update({ logo_url: saved.url }).eq("id", scope.dealerUuid);
    if (upErr) return NextResponse.json({ error: "Saved to your logo library, but couldn't set it as the dealer logo." }, { status: 500 });
  }

  fireWrite(db.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: setAsDealerLogo ? "dealer_logo_set_from_logo_studio" : "logo_studio_saved",
    target_dealer_id: scope.kind === "dealer" ? scope.dealerTextId : null,
    metadata: {
      image_library_id: saved.id, url: saved.url, png_url: saved.pngUrl, scope: scope.kind,
      group_id: scope.kind === "group" ? scope.groupId : null,
      ...(setAsDealerLogo ? { previous_logo_url: previousLogo } : {}),
    },
  }), "admin_audit");

  return NextResponse.json({ ok: true, image: saved, logo_url: setAsDealerLogo ? saved.url : null });
}
