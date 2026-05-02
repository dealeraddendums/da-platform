import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: required key + username. New: Supabase JWT.
// super_admin gets all; group_admin gets their group; dealer_admin gets own.
// Data source: Supabase dealers table

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("dealers")
    .select("active, name, dealer_id, primary_contact, primary_contact_email, address, city, state, zip, country, phone, account_type, feed_source, referred_by, groups(name)")
    .order("name");

  if (claims.role === "super_admin") {
    // no additional filter
  } else if (claims.role === "group_admin" && claims.group_id) {
    query = query.eq("group_id", claims.group_id) as typeof query;
  } else {
    if (!claims.dealer_id) {
      return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
    }
    query = query.eq("dealer_id", claims.dealer_id) as typeof query;
  }

  const { data, error: dbErr } = await query;
  if (dbErr) return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });

  // Map to legacy column names
  const mapped = (data ?? []).map((d: Record<string, unknown>) => ({
    ACTIVE: d.active ? "Yes" : "No",
    OWNER: null,
    DEALER_GROUP: (d.groups as { name: string } | null)?.name ?? null,
    DEALER_ID: d.dealer_id,
    DEALER_NAME: d.name,
    PRIMARY_CONTACT: d.primary_contact,
    PRIMARY_CONTACT_EMAIL: d.primary_contact_email,
    DEALER_ADDRESS: d.address,
    DEALER_CITY: d.city,
    DEALER_STATE: d.state,
    DEALER_ZIP: d.zip,
    DEALER_COUNTRY: d.country,
    DEALER_PHONE: d.phone,
    BILLING_DATE: null,
    ACCOUNT_TYPE: d.account_type,
    FEED_SOURCE: d.feed_source,
    REFERRED_BY: d.referred_by,
  }));

  return NextResponse.json(mapped);
}
