// Per-make template overrides (migration 153) — CRUD + the data the Settings UI
// needs to offer sane choices.
//
// Same auth shape as /api/settings: dealer_user is read-only-forbidden, and the
// target dealer comes from resolveDealerForRequest so group admins and ghosted
// super_admins act on the dealer they have switched into, never on a
// caller-supplied id they don't own.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveDealerForRequest } from "@/lib/dealer-authz";
import { makeKey } from "@/lib/make-key";

const DOC_TYPES = new Set(["addendum", "infosheet"]);
const CONDITIONS = new Set(["new", "used", "cpo", "any"]);

interface OverrideRow {
  id: string;
  dealer_id: string;
  make_key: string;
  condition: string;
  doc_type: string;
  template_id: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;
  const admin = createAdminSupabaseClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: overrides } = await (admin as any)
    .from("template_make_overrides")
    .select("id, dealer_id, make_key, condition, doc_type, template_id")
    .eq("dealer_id", dealerId)
    .order("make_key") as { data: OverrideRow[] | null };

  // The makes this dealer actually stocks, canonicalized and de-duplicated, so
  // a Hyundai+Genesis rooftop is offered exactly "Hyundai" and "Genesis"
  // instead of a list of every make in the industry. Paged past the 1000-row
  // clamp because a big store's active inventory exceeds it.
  const seen = new Map<string, { key: string; label: string; count: number }>();
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("dealer_vehicles")
      .select("make")
      .eq("dealer_id", dealerId)
      .eq("status", "active")
      .range(from, from + 999) as { data: Array<{ make: string | null }> | null };
    if (!data || data.length === 0) break;
    for (const r of data) {
      const key = makeKey(r.make);
      if (!key) continue;
      const cur = seen.get(key);
      if (cur) cur.count++;
      // Label = the first real spelling we saw, title-cased enough to read.
      else seen.set(key, { key, label: String(r.make ?? "").trim(), count: 1 });
    }
    if (data.length < 1000) break;
  }
  const makes = Array.from(seen.values()).sort((a, b) => b.count - a.count);

  return NextResponse.json({ data: overrides ?? [], makes });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  const body = await req.json().catch(() => null) as
    | { make: string; condition?: string; doc_type?: string; template_id: string }
    | null;
  if (!body?.make || !body?.template_id) {
    return NextResponse.json({ error: "make and template_id are required" }, { status: 400 });
  }
  const key = makeKey(body.make);
  if (!key) return NextResponse.json({ error: "Make must contain at least one letter or digit" }, { status: 400 });
  const condition = body.condition ?? "any";
  const doc_type = body.doc_type ?? "addendum";
  if (!CONDITIONS.has(condition)) return NextResponse.json({ error: "Invalid condition" }, { status: 400 });
  if (!DOC_TYPES.has(doc_type)) return NextResponse.json({ error: "Invalid doc_type" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // The template must belong to this dealer, or be a group template of the
  // dealer's group — otherwise an override could point a rooftop at another
  // dealer's branding.
  const { data: own } = await admin
    .from("templates").select("id").eq("id", body.template_id).eq("dealer_id", dealerId).maybeSingle();
  let allowed = Boolean(own);
  if (!allowed) {
    const { data: dealer } = await admin
      .from("dealers").select("group_id").eq("dealer_id", dealerId).maybeSingle<{ group_id: string | null }>();
    if (dealer?.group_id) {
      const { data: grp } = await admin
        .from("group_templates").select("id").eq("id", body.template_id).eq("group_id", dealer.group_id).maybeSingle();
      allowed = Boolean(grp);
    }
  }
  if (!allowed) return NextResponse.json({ error: "Template not found for this dealer" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: upsertErr } = await (admin as any)
    .from("template_make_overrides")
    .upsert({ dealer_id: dealerId, make_key: key, condition, doc_type, template_id: body.template_id },
            { onConflict: "dealer_id,make_key,condition,doc_type" })
    .select("id, dealer_id, make_key, condition, doc_type, template_id")
    .single();
  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // Scoped to the resolved dealer so an id from another dealer can't be deleted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: delErr } = await (admin as any)
    .from("template_make_overrides").delete().eq("id", id).eq("dealer_id", dealerId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
