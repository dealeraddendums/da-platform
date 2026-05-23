import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";

/**
 * POST /api/cron/qa-summary
 *
 * Daily summary email to allan@dealeraddendums.com. Triggered by EasyCron
 * at `0 14 * * *` UTC (7am Pacific). Header `x-cron-secret` must match
 * CRON_SECRET env var.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [itemsRes, allSubsRes, recentSubsRes] = await Promise.all([
    (admin as any).from("qa_test_items").select("id", { count: "exact", head: true }),
    (admin as any).from("qa_submissions").select("test_item_id, tester_name, result, notes, created_at, area"),
    (admin as any)
      .from("qa_submissions")
      .select("test_item_id, tester_name, result, notes, area, created_at")
      .gte("created_at", yesterday),
  ]);

  type SubRow = {
    test_item_id: string;
    tester_name: string | null;
    result: "pass" | "fail" | "suggestion";
    notes: string | null;
    area: string | null;
    created_at: string;
  };
  const totalItems = itemsRes.count ?? 0;
  const allSubs: SubRow[] = allSubsRes.data ?? [];
  const recent: SubRow[] = recentSubsRes.data ?? [];

  // Coverage: how many distinct items have at least one submission?
  const covered = new Set(allSubs.map(s => s.test_item_id)).size;

  // Counts since yesterday.
  const newPasses = recent.filter(s => s.result === "pass").length;
  const newFails = recent.filter(s => s.result === "fail");
  const newSuggestions = recent.filter(s => s.result === "suggestion");

  // Test item titles for hydration.
  const itemIds = Array.from(new Set(recent.map(s => s.test_item_id)));
  type ItemRow = { id: string; title: string };
  const itemsResp = itemIds.length
    ? await (admin as any).from("qa_test_items").select("id, title").in("id", itemIds)
    : { data: [] as ItemRow[] };
  const items: ItemRow[] = itemsResp.data ?? [];
  const titleById = new Map(items.map((i: ItemRow) => [i.id, i.title]));

  // Testers active today.
  const activeTesters: string[] = Array.from(
    new Set(recent.map(s => s.tester_name).filter((n): n is string => !!n)),
  );

  const today = new Date();
  const dayLabel = today.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const renderList = (
    rows: Array<{ test_item_id: string; tester_name: string | null; notes: string | null }>,
  ) =>
    rows.length === 0
      ? "<p style=\"color:#78828c;font-style:italic;margin:8px 0;\">None.</p>"
      : `<ul style="margin:8px 0 16px;padding-left:20px;">${rows
          .map(
            r =>
              `<li style="margin-bottom:8px;"><strong>${escapeHtml(titleById.get(r.test_item_id) ?? r.test_item_id)}</strong> — ${escapeHtml(r.tester_name ?? "unknown")}${r.notes ? `<br/><span style="color:#55595c">${escapeHtml(r.notes)}</span>` : ""}</li>`,
          )
          .join("")}</ul>`;

  const html = `<!DOCTYPE html><html><body style="font-family:Roboto,Arial,sans-serif;color:#333;max-width:680px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;margin:0 0 4px;color:#2a2b3c;">DA Platform QA Summary</h1>
  <p style="color:#78828c;margin:0 0 24px;font-size:14px;">${dayLabel}</p>

  <div style="background:#f5f6f7;border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin-bottom:24px;">
    <div style="font-size:14px;color:#55595c;margin-bottom:4px;">Overall Progress</div>
    <div style="font-size:18px;font-weight:700;color:#2a2b3c;">${covered} of ${totalItems} test items completed by at least one tester</div>
  </div>

  <h2 style="font-size:16px;margin:24px 0 8px;color:#2a2b3c;">New Since Yesterday</h2>
  <p style="margin:0 0 16px;font-size:14px;">
    <span style="color:#4caf50;font-weight:600;">${newPasses} passes</span> ·
    <span style="color:#ff5252;font-weight:600;">${newFails.length} fails</span> ·
    <span style="color:#ffa500;font-weight:600;">${newSuggestions.length} suggestions</span>
  </p>

  <h2 style="font-size:16px;margin:24px 0 4px;color:#ff5252;">New Failures</h2>
  ${renderList(newFails)}

  <h2 style="font-size:16px;margin:24px 0 4px;color:#ffa500;">New Suggestions</h2>
  ${renderList(newSuggestions)}

  <h2 style="font-size:16px;margin:24px 0 8px;color:#2a2b3c;">Testers Active Today</h2>
  ${
    activeTesters.length === 0
      ? "<p style=\"color:#78828c;font-style:italic;margin:8px 0;\">No tester activity in the last 24 hours.</p>"
      : `<p style="margin:8px 0;">${activeTesters.map(escapeHtml).join(", ")}</p>`
  }

  <hr style="border:none;border-top:1px solid #e0e0e0;margin:32px 0 16px;"/>
  <p style="margin:0;font-size:14px;">
    <a href="https://app.dealeraddendums.com/qa" style="color:#1976d2;text-decoration:none;font-weight:600;">Open QA Dashboard →</a>
  </p>
</body></html>`;

  try {
    await sendMandrillEmail({
      html,
      subject: `DA Platform QA Summary — ${dayLabel}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Platform QA",
      to: [{ email: "allan@dealeraddendums.com", type: "to" }],
    });
  } catch (err) {
    console.error("[cron/qa-summary] Mandrill send failed:", err);
    return NextResponse.json({ error: "Email send failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    coverage: { covered, total: totalItems },
    today: { passes: newPasses, fails: newFails.length, suggestions: newSuggestions.length },
    testers: activeTesters,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
