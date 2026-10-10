import { NextRequest, NextResponse } from "next/server";
import { builderDb, requireDealerBuilderScope } from "@/lib/image-builder/access";
import { fireWrite } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/image-library/set-dealer-logo { imageId } — Logo Composer's "Set as
 * my dealership logo" (2026-10-09). Points dealers.logo_url — what every Logo
 * widget prints, incl. group templates (forceDealerLogo, 1d4248d) — at a logo
 * from the dealer's logo library.
 *
 * The dealer is the SESSION's (same rule as the dealer Image Builder:
 * requireDealerBuilderScope). The image must be a LOGO (bucket new-dealer-logos)
 * that this dealer owns, or that this dealer's own group made. The client names
 * only the image; never the dealer.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, scope, error } = await requireDealerBuilderScope();
  if (error) return error;
  if (scope.kind !== "dealer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { imageId?: unknown };
  const imageId = typeof body.imageId === "string" ? body.imageId : "";
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) return NextResponse.json({ error: "imageId required" }, { status: 400 });

  const db = builderDb();
  const [{ data: img }, { data: dealer }] = await Promise.all([
    db.from("image_library").select("id, bucket, url, scope, group_id, dealer_id").eq("id", imageId).maybeSingle(),
    db.from("dealers").select("id, dealer_id, group_id, logo_url").eq("dealer_id", scope.dealerTextId).maybeSingle(),
  ]);
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  const ownsIt = !!img && img.bucket === "new-dealer-logos" && (
    (img.scope === "dealer" && img.dealer_id === scope.dealerTextId)
    || (img.scope === "group" && !!dealer.group_id && img.group_id === dealer.group_id)
  );
  if (!ownsIt) return NextResponse.json({ error: "Logo not found" }, { status: 404 });

  const { error: upErr } = await db.from("dealers").update({ logo_url: img.url }).eq("id", dealer.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  fireWrite(db.from("admin_audit").insert({
    admin_user_id: claims.sub, action: "dealer_logo_set_from_library", target_dealer_id: scope.dealerTextId,
    metadata: { image_library_id: img.id, image_scope: img.scope, previous_logo_url: dealer.logo_url ?? null, new_logo_url: img.url },
  }), "admin_audit");
  return NextResponse.json({ ok: true, logo_url: img.url });
}
