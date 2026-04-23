import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

export type HistoryEntry = {
  id: string;
  action: "import" | "edit" | "print" | "delete";
  method: string | null;
  document_type: string | null;
  changed_by: string | null;
  changed_by_email: string | null;
  user_full_name: string | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  created_at: string;
  source: "audit_log" | "print_history";
};

/** GET /api/dealer-vehicles/[id]/history — full audit trail */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const isAdmin = (claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id;
  if (isAdmin) return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  if (!dealerId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  const admin = createAdminSupabaseClient();

  const [auditRes, printRes] = await Promise.all([
    admin
      .from("vehicle_audit_log")
      .select("*")
      .eq("vehicle_id", params.id)
      .eq("dealer_id", dealerId)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("print_history")
      .select("id, vehicle_id, dealer_id, document_type, printed_by, created_at")
      .eq("vehicle_id", params.id)
      .eq("dealer_id", dealerId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (auditRes.error) return NextResponse.json({ error: auditRes.error.message }, { status: 500 });

  const auditRows = auditRes.data ?? [];
  const printRows = printRes.data ?? [];

  // Collect all user UUIDs to resolve full names in one query
  const userIds = new Set<string>();
  for (const r of auditRows) if (r.changed_by) userIds.add(r.changed_by as string);
  for (const r of printRows) if (r.printed_by) userIds.add(r.printed_by as string);

  const nameMap: Record<string, string> = {};
  if (userIds.size > 0) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", Array.from(userIds));
    for (const p of profiles ?? []) {
      if (p.full_name) nameMap[p.id as string] = p.full_name as string;
    }
  }

  const auditEntries: HistoryEntry[] = auditRows.map((r) => ({
    id: r.id as string,
    action: r.action as HistoryEntry["action"],
    method: r.method as string | null,
    document_type: r.document_type as string | null,
    changed_by: r.changed_by as string | null,
    changed_by_email: r.changed_by_email as string | null,
    user_full_name: r.changed_by ? (nameMap[r.changed_by as string] ?? null) : null,
    changes: r.changes as Record<string, { old: unknown; new: unknown }> | null,
    created_at: r.created_at as string,
    source: "audit_log" as const,
  }));

  // Supplement with print_history entries not already covered by audit_log
  const auditPrintTimes = auditEntries
    .filter((e) => e.action === "print")
    .map((e) => new Date(e.created_at).getTime());

  const supplementPrints: HistoryEntry[] = (printRows ?? [])
    .filter((ph) => {
      const t = new Date(ph.created_at as string).getTime();
      return !auditPrintTimes.some((at) => Math.abs(at - t) < 30_000);
    })
    .map((ph) => ({
      id: ph.id as string,
      action: "print" as const,
      method: "print",
      document_type: ph.document_type as string | null,
      changed_by: ph.printed_by as string | null,
      changed_by_email: null,
      user_full_name: ph.printed_by ? (nameMap[ph.printed_by as string] ?? null) : null,
      changes: null,
      created_at: ph.created_at as string,
      source: "print_history" as const,
    }));

  const combined = [...auditEntries, ...supplementPrints]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return NextResponse.json({ data: combined });
}
