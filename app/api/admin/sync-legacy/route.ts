import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

const toTs = (v: Date | null) => v ? v.toISOString() : null;

/**
 * POST /api/admin/sync-legacy
 * Imports groups then dealers from Aurora into Supabase, then links group_id.
 * super_admin only. Returns { groups_imported, dealers_imported, duration_ms, synced_at }.
 */
export async function POST(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const start = Date.now();
  const admin = createAdminSupabaseClient();

  try {
    const pool = getPool();

    // ── Import groups ────────────────────────────────────────────────────────
    interface AuroraGroup extends RowDataPacket {
      _ID: number; GROUP_NAME: string | null; BILLING_ID: string | null;
      TEMPLATE_ID: string | null; GROUP_FEE: string | null; BILLING_CONTACT: string | null;
      BILLING_ADDRESS: string | null; BILLING_CITY: string | null; BILLING_STATE: string | null;
      BILLING_ZIP: string | null; BILLING_COUNTRY: string | null; BILLING_DATE: string | null;
      PHONE: string | null; EMAIL: string | null; HUBSPOT_COMPANY_ID: string | null;
      created_at: Date | null;
    }

    const [groupRows] = await pool.execute<AuroraGroup[]>(
      `SELECT _ID, GROUP_NAME, BILLING_ID, TEMPLATE_ID, GROUP_FEE,
              BILLING_CONTACT, BILLING_ADDRESS, BILLING_CITY, BILLING_STATE,
              BILLING_ZIP, BILLING_COUNTRY, BILLING_DATE, PHONE, EMAIL,
              HUBSPOT_COMPANY_ID, created_at
       FROM dealer_group ORDER BY _ID ASC`
    );

    const groupRecords = groupRows.map((r) => ({
      legacy_id:          r._ID,
      internal_id:        String(r._ID),
      name:               r.GROUP_NAME ?? `Group ${r._ID}`,
      billing_id:         r.BILLING_ID ?? null,
      template_id:        r.TEMPLATE_ID ?? null,
      group_fee:          r.GROUP_FEE ?? "0",
      billing_contact:    r.BILLING_CONTACT ?? null,
      billing_address:    r.BILLING_ADDRESS ?? null,
      billing_city:       r.BILLING_CITY ?? null,
      billing_state:      r.BILLING_STATE ?? null,
      billing_zip:        r.BILLING_ZIP ?? null,
      billing_country:    r.BILLING_COUNTRY ?? "US",
      billing_date:       r.BILLING_DATE ?? null,
      phone:              r.PHONE ?? null,
      email:              r.EMAIL ?? null,
      hubspot_company_id: r.HUBSPOT_COMPANY_ID ?? null,
      created_at:         toTs(r.created_at),
    }));

    if (groupRecords.length > 0) {
      const { error: gErr } = await admin.from("groups").upsert(groupRecords as unknown as never[], { onConflict: "legacy_id" });
      if (gErr) return NextResponse.json({ error: `Groups import failed: ${gErr.message}` }, { status: 500 });
    }

    // ── Import dealers in chunks of 500 ──────────────────────────────────────
    interface AuroraDealer extends RowDataPacket {
      _ID: number; BILLING_ID: string | null; TEMPLATE_ID: string | null;
      DEALER_GROUP: string | null; DEALER_ID: string | null; DEALER_NAME: string | null;
      PRIMARY_CONTACT: string | null; PRIMARY_CONTACT_EMAIL: string | null;
      DEALER_LOGO: string | null; DEALER_ADDRESS: string | null; DEALER_CITY: string | null;
      DEALER_STATE: string | null; DEALER_ZIP: string | null; DEALER_COUNTRY: string | null;
      DEALER_PHONE: string | null; BILLING_STREET: string | null; BILLING_CITY: string | null;
      BILLING_STATE: string | null; BILLING_ZIP: string | null; BILLING_COUNTRY: string | null;
      SUB_BILLING_TO: string | null; BILLING_TO: string | null; ACCOUNT_TYPE: string | null;
      FEED_SOURCE: string | null; ETL_JOB: string | null; REFERRED_BY: string | null;
      MAKE1: string | null; MAKE2: string | null; MAKE3: string | null;
      MAKE4: string | null; MAKE5: string | null;
      LAT1: string | null; LNG1: string | null;
      HUBSPOT_COMPANY_ID: string | null; AGENT_NAME: string | null;
      EMAIL_REPORT: number | null; REPORT_SEND_TO: string | null;
      LAST30: number | null; created_at: Date | null;
    }

    let lastId = 0;
    let dealersImported = 0;
    const CHUNK = 500;

    while (true) {
      const [rows] = await pool.execute<AuroraDealer[]>(
        `SELECT _ID, BILLING_ID, TEMPLATE_ID, DEALER_GROUP,
                DEALER_ID, DEALER_NAME, PRIMARY_CONTACT, PRIMARY_CONTACT_EMAIL,
                DEALER_LOGO, DEALER_ADDRESS, DEALER_CITY, DEALER_STATE,
                DEALER_ZIP, DEALER_COUNTRY, DEALER_PHONE, BILLING_STREET,
                BILLING_CITY, BILLING_STATE, BILLING_ZIP, BILLING_COUNTRY,
                SUB_BILLING_TO, BILLING_TO, ACCOUNT_TYPE, FEED_SOURCE,
                ETL_JOB, REFERRED_BY, MAKE1, MAKE2, MAKE3, MAKE4, MAKE5,
                LAT1, LNG1, HUBSPOT_COMPANY_ID, AGENT_NAME,
                EMAIL_REPORT, REPORT_SEND_TO, LAST30, created_at
         FROM dealer_dim
         WHERE ACTIVE = 'Yes' AND _ID > ?
         ORDER BY _ID ASC LIMIT ?`,
        [lastId, CHUNK]
      );
      if (!rows.length) break;

      const records = rows.map((r) => ({
        legacy_id:              r._ID,
        internal_id:            String(r._ID),
        inventory_dealer_id:    r.DEALER_ID ?? String(r._ID),
        dealer_id:              r.DEALER_ID ?? String(r._ID),
        billing_id:             r.BILLING_ID ?? null,
        template_id:            r.TEMPLATE_ID ?? null,
        name:                   r.DEALER_NAME ?? `Dealer ${r._ID}`,
        active:                 true,
        dealer_group_legacy:    r.DEALER_GROUP ?? null,
        account_type:           r.ACCOUNT_TYPE ?? "Standard",
        feed_source:            r.FEED_SOURCE ?? null,
        etl_job:                r.ETL_JOB ?? null,
        primary_contact:        r.PRIMARY_CONTACT ?? null,
        primary_contact_email:  r.PRIMARY_CONTACT_EMAIL ?? null,
        logo_url:               r.DEALER_LOGO ?? null,
        address:                r.DEALER_ADDRESS ?? null,
        city:                   r.DEALER_CITY ?? null,
        state:                  r.DEALER_STATE ?? null,
        zip:                    r.DEALER_ZIP ?? null,
        country:                r.DEALER_COUNTRY ?? "USA",
        phone:                  r.DEALER_PHONE ?? null,
        billing_street:         r.BILLING_STREET ?? null,
        billing_city:           r.BILLING_CITY ?? null,
        billing_state:          r.BILLING_STATE ?? null,
        billing_zip:            r.BILLING_ZIP ?? null,
        billing_country:        r.BILLING_COUNTRY ?? "USA",
        sub_billing_to:         r.SUB_BILLING_TO ?? "Dealer",
        billing_to:             r.BILLING_TO ?? "Dealer",
        referred_by:            r.REFERRED_BY ?? null,
        make1:                  r.MAKE1 ?? null,
        make2:                  r.MAKE2 ?? null,
        make3:                  r.MAKE3 ?? null,
        make4:                  r.MAKE4 ?? null,
        make5:                  r.MAKE5 ?? null,
        lat:                    r.LAT1 ?? null,
        lng:                    r.LNG1 ?? null,
        hubspot_company_id:     r.HUBSPOT_COMPANY_ID ?? null,
        agent_name:             r.AGENT_NAME ?? null,
        email_report:           r.EMAIL_REPORT ?? 0,
        report_send_to:         r.REPORT_SEND_TO ?? null,
        last30:                 r.LAST30 ?? null,
        created_at:             toTs(r.created_at),
      }));

      const { error: dErr } = await admin.from("dealers").upsert(records as unknown as never[], { onConflict: "legacy_id" });
      if (dErr) return NextResponse.json({ error: `Dealers import failed: ${dErr.message}` }, { status: 500 });

      lastId = rows[rows.length - 1]._ID;
      dealersImported += rows.length;
    }

    // ── Link dealers → groups via dealer_group_legacy (case-insensitive) ───────
    await admin.from("dealers")
      .select("id, dealer_group_legacy")
      .not("dealer_group_legacy", "is", null)
      .eq("group_id", null as unknown as string)
      .then(async ({ data: unlinked }) => {
        if (!unlinked?.length) return;
        const { data: groups } = await admin.from("groups").select("id, name");
        // Case-insensitive, trimmed match to handle Aurora data inconsistencies
        const nameToId = new Map(
          (groups ?? []).map(g => [g.name.toLowerCase().trim(), g.id])
        );
        const updates = (unlinked)
          .filter(d => d.dealer_group_legacy && nameToId.has(d.dealer_group_legacy.toLowerCase().trim()))
          .map(d => ({
            id: d.id,
            group_id: nameToId.get(d.dealer_group_legacy!.toLowerCase().trim())!,
          }));
        for (const u of updates) {
          await admin.from("dealers").update({ group_id: u.group_id }).eq("id", u.id);
        }
      });

    // ── Record sync timestamp ─────────────────────────────────────────────────
    const syncedAt = new Date().toISOString();
    await admin.from("admin_settings").upsert({ key: "last_dealer_sync", value: syncedAt });

    return NextResponse.json({
      groups_imported: groupRecords.length,
      dealers_imported: dealersImported,
      duration_ms: Date.now() - start,
      synced_at: syncedAt,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    console.error("[sync-legacy]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
