import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };
const SELECT = "id, name, sort_order, published, created_at, updated_at";

/** PUT /api/help/categories/[id] — rename / reorder / publish. super_admin only. */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let renamedTo: string | null = null;
  if (typeof body.name === "string" && body.name.trim()) {
    renamedTo = body.name.trim().slice(0, 80);
    patch.name = renamedTo;
  }
  if (Number.isFinite(body.sort_order as number)) patch.sort_order = body.sort_order;
  if (typeof body.published === "boolean") patch.published = body.published;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("help_categories").update(patch).eq("id", params.id).select(SELECT).single();
  if (dbErr) {
    if (dbErr.code === "23505") return NextResponse.json({ error: "A category with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // help_articles.category (text) is a denormalized copy of the category name —
  // the Help assistant's retrieval reads it (lib/help-context.ts). A rename that
  // didn't carry through would leave the assistant labelling grounding material
  // with a category the dealer can no longer see.
  if (renamedTo) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("help_articles").update({ category: renamedTo }).eq("category_id", params.id);
  }

  return NextResponse.json({ data });
}

/**
 * DELETE /api/help/categories/[id] — super_admin only.
 * Refused while articles still live in it: the FK is ON DELETE SET NULL, so a
 * blind delete would silently orphan real content out of the browse tree
 * instead of failing loudly. Move or delete the articles first.
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (admin as any)
    .from("help_articles").select("id", { count: "exact", head: true }).eq("category_id", params.id);
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `This category still has ${count} article${count === 1 ? "" : "s"}. Move or delete them first.` },
      { status: 409 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("help_categories").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
