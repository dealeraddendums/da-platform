import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import { getBillingSummary, type BillingSummary } from "@/lib/billing";

export const metadata = { title: "Billing — DA Platform" };

// Billing runs as the standalone da-billing app (Phase 10, shipped) — this
// page is a combined financial-health mini-dashboard: da-billing (live via
// /reports/summary, 5-min cached in lib/billing.ts) beside FreshBooks (the
// legacy side, computed nightly by the ETL box into
// admin_settings.fb_billing_summary), plus combined totals. Either source
// missing degrades to a notice — the page always renders.

const BILLING_URL = "https://billing.dealeraddendums.com";

const STAT_LABEL = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  marginBottom: 6,
};

const SECTION_LABEL = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase" as const,
  letterSpacing: "0.08em",
  color: "var(--text-muted)",
  margin: "0 0 10px",
};

const RED = "#d32f2f";
const AMBER = "#f57c00";

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

// ── FreshBooks nightly summary (admin_settings.fb_billing_summary) ──────────

interface FbCoverageSlice {
  count: number;
  monthly: number;
}

interface FbSummary {
  fb_mrr: number;
  fb_active_profiles: number;
  fb_outstanding: { count: number; total: number };
  double_billing_suspects: { count: number; names: string[] };
  /** Since 2026-09-01: full-coverage enumeration breakdown (all Aurora
   *  RECURE_IDs + invoice-parent scan, not just active-dealer links) — see
   *  ETL runFbBillingSummaryJob. Absent on pre-coverage snapshots. */
  fb_coverage?: {
    via_active_dealers: FbCoverageSlice;
    other_aurora_links: FbCoverageSlice;
    invoice_only: FbCoverageSlice;
    invoice_scan_days: number;
  };
  computed_at: string;
}

const FB_STALE_MS = 36 * 60 * 60 * 1000; // amber past 36h (nightly job missed a run)

async function getFbSummary(admin: ReturnType<typeof createAdminSupabaseClient>): Promise<FbSummary | null> {
  try {
    const { data } = await admin
      .from("admin_settings")
      .select("value")
      .eq("key", "fb_billing_summary")
      .maybeSingle<{ value: string }>();
    if (!data?.value) return null;
    const parsed = JSON.parse(data.value) as FbSummary;
    if (typeof parsed?.fb_mrr !== "number" || typeof parsed?.computed_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Building blocks ──────────────────────────────────────────────────────────

function StatCard({ label, value, note, accent }: { label: string; value: string; note?: ReactNode; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p style={STAT_LABEL}>{label}</p>
      <p className="text-2xl font-semibold" style={{ color: accent ? RED : "var(--text-primary)" }}>
        {value}
      </p>
      {note ? (
        <p className="text-xs mt-1" style={{ color: accent ? RED : "var(--text-muted)" }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

function DegradedCard({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="card p-5 flex items-start gap-3">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div>
        <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</p>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>{body}</p>
      </div>
    </div>
  );
}

function OpenBillingButton() {
  return (
    <a
      href={BILLING_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 text-sm font-medium text-white rounded px-4 py-2"
      style={{ background: "#1976d2" }}
    >
      Open DA Billing
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function BillingPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");

  const role = profile?.role ?? (session.user.app_metadata as Record<string, unknown>)?.role;
  if (role !== "super_admin") redirect("/dashboard");

  const [da, fb]: [BillingSummary | null, FbSummary | null] = await Promise.all([
    getBillingSummary(),
    getFbSummary(admin),
  ]);

  const fbComputedAt = fb ? new Date(fb.computed_at) : null;
  const fbStale = !!(fbComputedAt && Date.now() - fbComputedAt.getTime() > FB_STALE_MS);
  const fbAsOf = fbComputedAt
    ? fbComputedAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT"
    : null;

  const combined = da && fb
    ? {
        mrr: da.mrr + fb.fb_mrr,
        outstanding: da.past_due.outstanding_total + fb.fb_outstanding.total,
        pctOnDaBilling: da.mrr + fb.fb_mrr > 0 ? Math.round((da.mrr / (da.mrr + fb.fb_mrr)) * 1000) / 10 : 0,
      }
    : null;

  return (
    <div>
      <PageHeader title="Billing" action={<OpenBillingButton />} />

      {/* ── COMBINED — the one-glance financial-health row ──────────────── */}
      <section className="mb-8">
        <p style={SECTION_LABEL}>Combined — DA Billing + FreshBooks</p>
        {combined ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard label="Total MRR" value={usd(combined.mrr)} note="da-billing + FreshBooks run-rate" />
              <StatCard
                label="Total Outstanding"
                value={usd(combined.outstanding)}
                note="da-billing past-due + FreshBooks unpaid invoices"
                accent={combined.outstanding > 0}
              />
              <StatCard
                label="Migration Progress"
                value={`${combined.pctOnDaBilling}%`}
                note="of MRR now on da-billing — trends to 100%"
              />
            </div>
            <div className="mt-3 card" style={{ height: 8, overflow: "hidden", padding: 0 }}>
              <div style={{ width: `${Math.min(100, combined.pctOnDaBilling)}%`, height: "100%", background: "#1976d2" }} />
            </div>
          </>
        ) : (
          <DegradedCard
            title="Combined totals unavailable"
            body={!da
              ? "The da-billing summary couldn't be loaded — see below."
              : "The FreshBooks nightly summary hasn't been computed yet — it lands after the next ETL nightly run."}
          />
        )}
      </section>

      {/* ── DA BILLING (live, 5-min cached) ─────────────────────────────── */}
      <section className="mb-8">
        <p style={SECTION_LABEL}>DA Billing — live</p>
        {da ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Monthly Recurring Revenue" value={usd(da.mrr)} note="Live, non-paused subscriptions" />
            <StatCard
              label="Active Customers"
              value={da.active_customers.toLocaleString()}
              note={`${da.setup_mode_customers.toLocaleString()} more in Setup Mode`}
            />
            <StatCard
              label="Past Due"
              value={da.past_due.count.toLocaleString()}
              note={da.past_due.count > 0 ? `${usd(da.past_due.outstanding_total)} outstanding` : "No past-due accounts"}
              accent={da.past_due.count > 0}
            />
            <StatCard
              label="Invoices This Month"
              value={da.invoices_this_month.generated.toLocaleString()}
              note={`${da.invoices_this_month.sent.toLocaleString()} sent · ${da.invoices_this_month.paid.toLocaleString()} paid`}
            />
          </div>
        ) : (
          <DegradedCard
            title="DA Billing unreachable — open it directly"
            body={
              <>
                The summary couldn&apos;t be loaded right now. The full billing app at{" "}
                <a href={BILLING_URL} target="_blank" rel="noopener noreferrer" style={{ color: "#1976d2" }}>
                  billing.dealeraddendums.com
                </a>{" "}
                is unaffected.
              </>
            }
          />
        )}
      </section>

      {/* ── FRESHBOOKS (nightly snapshot from the ETL box) ──────────────── */}
      <section className="mb-6">
        <p style={SECTION_LABEL}>FreshBooks — legacy (nightly snapshot)</p>
        {fb ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Monthly Recurring Revenue"
                value={usd(fb.fb_mrr)}
                note={fb.fb_coverage
                  ? `All active recurring profiles — incl. ${(fb.fb_coverage.other_aurora_links.count + fb.fb_coverage.invoice_only.count).toLocaleString()} beyond active dealer links (${usd(fb.fb_coverage.other_aurora_links.monthly + fb.fb_coverage.invoice_only.monthly)}/mo)`
                  : "Active recurring profiles, monthly run-rate"}
              />
              <StatCard label="Active Profiles" value={fb.fb_active_profiles.toLocaleString()} note="Recurring profiles still billing on FreshBooks" />
              <StatCard
                label="Outstanding"
                value={fb.fb_outstanding.count.toLocaleString()}
                note={fb.fb_outstanding.count > 0 ? `${usd(fb.fb_outstanding.total)} unpaid` : "No unpaid invoices"}
                accent={fb.fb_outstanding.count > 0}
              />
              <div className="card p-4">
                <p style={STAT_LABEL}>Double-Billing Suspects</p>
                {fb.double_billing_suspects.count > 0 ? (
                  <details>
                    <summary
                      className="text-sm font-semibold cursor-pointer inline-flex items-center gap-2"
                      style={{ color: RED }}
                    >
                      <span
                        className="inline-block rounded-full text-white text-xs font-bold px-2 py-0.5"
                        style={{ background: RED }}
                      >
                        {fb.double_billing_suspects.count}
                      </span>
                      active on FreshBooks after cutover
                    </summary>
                    <ul className="text-xs mt-2 pl-4 list-disc" style={{ color: "var(--text-primary)" }}>
                      {fb.double_billing_suspects.names.map((n) => (
                        <li key={n} className="mt-0.5">{n}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <>
                    <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>0</p>
                    <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                      No cut-over dealers still billing on FreshBooks
                    </p>
                  </>
                )}
              </div>
            </div>
            <p className="text-xs mt-2" style={{ color: fbStale ? AMBER : "var(--text-muted)" }}>
              {fbStale ? "⚠ Stale — " : ""}as of {fbAsOf} (computed nightly on the ETL box; FreshBooks is read-only from here)
            </p>
          </>
        ) : (
          <DegradedCard
            title="FreshBooks summary not available yet"
            body="No fb_billing_summary snapshot found — it's computed by the nightly ETL run (or the run was skipped because the legacy FreshBooks token was mid-rotation). The last-good snapshot is kept once one exists."
          />
        )}
      </section>

      <p className="text-sm mt-4" style={{ color: "var(--text-muted)" }}>
        Full invoice management, refunds, recurring templates, and reports live in DA Billing.
        {da ? " DA Billing figures refresh every 5 minutes." : ""}
      </p>
    </div>
  );
}
