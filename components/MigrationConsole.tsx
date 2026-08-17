"use client";

import { Fragment, useEffect, useMemo, useState } from "react";

interface Row {
  id: string;
  dealer_id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  state: string | null;
  billingStaged: boolean;
  billingReason: string;
  billingApplicable?: boolean;
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;
  ready: boolean;
  settingsMissing: boolean;
  logoMissing: boolean;
  zeroInventory: boolean;
  warnings: string[];
  inviteStatus: "not-invited" | "invited" | "stalled" | "expired" | "migrated";
  invitedAt: string | null;
  waveId: string | null;
  inviteRecipients?: string[];
  freshbooksStoppedAt: string | null;
  freshbooksStopPending: boolean;
  isNative: boolean;
  assignedTo: string | null;
  migrationStatus: string | null;
  synced: boolean;
  etlLocked?: boolean;
  lastSyncedAt: string | null;
}
// Per-step billing/config enrichment report returned by /api/migration/sync
// (mirrors lib/migration-sync-enrichment.ts EnrichmentReport).
interface EnrichmentStep { status: string; detail?: string; warning?: boolean }
interface EnrichmentReport {
  billedTo: "dealer" | "group";
  customerId: string | null;
  provider: EnrichmentStep;
  subscription: EnrichmentStep;
  planCheck: EnrichmentStep;
  contacts: EnrichmentStep;
  nextInvoice: EnrichmentStep;
}
function enrichmentAlertLines(rep: EnrichmentReport): string[] {
  const fmt = (label: string, s: EnrichmentStep) => `${s.warning ? "⚠ " : ""}${label}: ${s.detail ?? s.status}`;
  return [
    fmt("Inventory provider", rep.provider),
    fmt("Subscription (4.0 → 5.0)", rep.subscription),
    fmt(`Billing plan (${rep.billedTo}-billed)`, rep.planCheck),
    fmt("Billing contacts", rep.contacts),
    fmt("Next invoice date", rep.nextInvoice),
  ];
}
interface Wave { waveId: string; sentAt: string | null; sent: number; migrated: number; pending: number; }
interface Operator { id: string; name: string; }
interface Summary { total: number; ready: number; eligible: number; billingStaged: number; templateConfirmed: number; readyPool: number; settingsMissing: number; logoMissing: number; zeroInventory: number; freshbooksStopPending: number; unassigned: number; }
interface ApiResp { rows: Row[]; summary: Summary; operators: Operator[]; currentUserId: string; flagsColumnPresent: boolean; billingTemplatesLoaded: number; note: string; }
// Billing Pending tab rows — migrated dealers whose da-billing template is still
// paused. Fetched from /api/migration/billing-pending (NOT derived from readiness
// rows, which exclude migrated dealers — that's why the tab was always empty).
interface BillingPendingDealer { id: string; name: string; group_name: string | null; account_type: string | null; billing_customer_id: string | null; }

const NAVY = "#2a2b3c";

const Check = ({ ok, title }: { ok: boolean; title?: string }) => (
  <span title={title} style={{ color: ok ? "#2e7d32" : "#c62828", fontWeight: 700 }}>{ok ? "✓" : "✗"}</span>
);

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  "not-invited": { bg: "#f0f0f0", fg: "#78828c", label: "Not invited" },
  invited: { bg: "#e3f2fd", fg: "#1565c0", label: "Invited" },
  stalled: { bg: "#fff3e0", fg: "#b06a00", label: "Stalled" },
  expired: { bg: "#ffebee", fg: "#c62828", label: "Expired" },
  migrated: { bg: "#e8f5e9", fg: "#2e7d32", label: "Migrated" },
};
const StatusBadge = ({ status, invitedAt, recipients }: { status: string; invitedAt: string | null; recipients?: string[] }) => {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE["not-invited"];
  const date = invitedAt && (status === "invited" || status === "stalled" || status === "expired") ? new Date(invitedAt).toLocaleDateString() : null;
  // Hover shows the multi-recipient invite list (✓ = that recipient completed).
  const title = [date ? `invited ${date}` : s.label, ...(recipients && recipients.length ? ["sent to:", ...recipients.map(r => `  ${r}`)] : [])].join("\n");
  return <span title={title} style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{s.label}{date ? ` · ${date}` : ""}</span>;
};

// Per-row billing activation state.
type ActivateState = { status: "idle" | "loading" | "done" | "error"; message?: string };

export default function MigrationConsole() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Tab: "readiness" (default) | "billing-pending"
  const [activeTab, setActiveTab] = useState<"readiness" | "billing-pending">("readiness");
  const [activateStates, setActivateStates] = useState<Record<string, ActivateState>>({});

  // wave selection (Ready rows only) + send
  const CAP = 100;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [waveResult, setWaveResult] = useState<{ summary: { requested: number; sent: number; failed: number; blocked: number }; failed: { name: string; error: string }[]; blocked: { name: string; reason: string }[] } | null>(null);

  // filters
  const [readyOnly, setReadyOnly] = useState(false);
  const [fbPending, setFbPending] = useState(false);
  const [stagedOnly, setStagedOnly] = useState(false);
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assignFilter, setAssignFilter] = useState("me"); // "" all | "me" | "unassigned" | <operatorId>

  // wave summaries (13b step 3)
  const [waves, setWaves] = useState<Wave[]>([]);
  const [resendingId, setResendingId] = useState<string | null>(null);

  // operator assignment
  const [assignTarget, setAssignTarget] = useState("me"); // "me" | "unassign" | <operatorId>
  const [assigning, setAssigning] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimingGroup, setClaimingGroup] = useState<string | null>(null);
  const [syncingGroup, setSyncingGroup] = useState<string | null>(null);
  // Group-level migration modals (2026-07-17): invite group admins + migrate group.
  const [inviteAdminsGroup, setInviteAdminsGroup] = useState<{ id: string; name: string } | null>(null);
  const [migrateGroup, setMigrateGroup] = useState<{ id: string; name: string } | null>(null);

  const me = data?.currentUserId ?? "";
  const operators = data?.operators ?? [];
  const opName = (id: string | null) => !id ? null : (id === me ? "Me" : (operators.find((o) => o.id === id)?.name ?? "—"));

  // Dealers who completed /migrate but still need billing activated — fetched
  // from a dedicated endpoint (migrated dealers + paused da-billing template).
  const [billingPending, setBillingPending] = useState<BillingPendingDealer[]>([]);
  const [bpErr, setBpErr] = useState<string | null>(null);

  const loadBillingPending = async () => {
    setBpErr(null);
    try {
      const res = await fetch("/api/migration/billing-pending");
      const j = await res.json() as { dealers?: BillingPendingDealer[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Failed to load billing-pending");
      setBillingPending(j.dealers ?? []);
    } catch (e) {
      setBpErr(e instanceof Error ? e.message : "Failed to load billing-pending");
    }
  };

  async function activateBilling(dealerId: string) {
    setActivateStates((s) => ({ ...s, [dealerId]: { status: "loading" } }));
    try {
      const res = await fetch("/api/migration/activate-billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: dealerId }),
      });
      const j = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActivateStates((s) => ({ ...s, [dealerId]: { status: "error", message: j.error ?? "Activation failed" } }));
      } else {
        setActivateStates((s) => ({ ...s, [dealerId]: { status: "done" } }));
      }
    } catch (e) {
      setActivateStates((s) => ({ ...s, [dealerId]: { status: "error", message: e instanceof Error ? e.message : "Activation failed" } }));
    }
  }

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/migration/readiness");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json as ApiResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };
  const loadWaves = async () => {
    try { const r = await fetch("/api/migration/waves"); const j = await r.json(); if (r.ok) setWaves(j.waves ?? []); } catch { /* */ }
  };
  useEffect(() => { void load(); void loadWaves(); void loadBillingPending(); }, []);

  async function resend(row: Row) {
    if (!confirm(`Resend a migration invite to ${row.name}? A fresh one-time code goes to their contact (resets the stall clock).`)) return;
    setResendingId(row.id);
    try {
      const res = await fetch("/api/migration/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerId: row.id }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Resend failed"); return; }
      if (j.allCompleted) {
        alert("All recipients have already accepted — nothing to resend.");
        return;
      }
      // List exactly who got a fresh code; completed recipients are skipped.
      const sent = (j.recipients as string[] | undefined)?.join(", ") ?? j.email ?? "";
      const skipped = (j.skipped as string[] | undefined) ?? [];
      alert(`Invite resent to ${sent}.${skipped.length ? `\nSkipped (already accepted): ${skipped.join(", ")}` : ""}${j.warning ? `\n⚠ ${j.warning}` : ""}`);
      await load();
    } catch { alert("Resend failed"); } finally { setResendingId(null); }
  }

  // Stage a dealer for an upcoming wave → migration_status='pending', which
  // Manual Aurora → 5.0 sync (replaces "stage", 2026-07-17). First sync pulls
  // the dealer's current 4.0 data (products, logo, settings, dealer record)
  // into 5.0; a RE-sync overwrites any 5.0 hand-config with 4.0 again, so it
  // gets a scarier confirm. Reflected optimistically; full reload catches up.
  async function syncDealer(row: Row): Promise<boolean> {
    if (row.lastSyncedAt) {
      if (!confirm(`Re-sync ${row.name}? This overwrites their V5.0 logo, products, and settings with current Platform 4.0 data.`)) return false;
    } else {
      if (!confirm(`Sync ${row.name}? This pulls their current Platform 4.0 data (products, logo, settings) into 5.0. Nothing will overwrite them afterwards.`)) return false;
    }
    return (await syncDealerNoConfirm(row)).ok;
  }

  async function syncDealerNoConfirm(row: Row, opts?: { quiet?: boolean }): Promise<{ ok: boolean; refused?: string; report: EnrichmentReport | null }> {
    setStagingId(row.id);
    try {
      const res = await fetch("/api/migration/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealer_ids: [row.id] }) });
      const j = await res.json() as { error?: string; synced_at?: string; dealers?: Array<{ status: string; reason?: string; enrichment_report?: EnrichmentReport | null }> };
      if (!res.ok) { alert(j.error ?? "Sync failed"); return { ok: false, report: null }; }
      const d0 = j.dealers?.[0];
      if (d0 && d0.status !== "synced") {
        // Per-dealer refusal (migrated / etl_locked / 4.0 trial / …). In a
        // group run the caller collects these and continues; solo it alerts.
        const reason = d0.reason ?? d0.status;
        if (!opts?.quiet) alert(`${row.name}: ${reason}`);
        return { ok: false, refused: reason, report: null };
      }
      setData((d) => d && {
        ...d,
        rows: d.rows.map((r) => r.id === row.id
          ? {
              ...r,
              migrationStatus: r.migrationStatus === null || r.migrationStatus === "legacy" ? "pending" : r.migrationStatus,
              lastSyncedAt: j.synced_at ?? new Date().toISOString(),
              synced: true,
              ready: r.billingStaged && r.templateConfirmed && r.eligible,
            }
          : r),
      });
      const report = d0?.enrichment_report ?? null;
      if (!opts?.quiet && report) {
        alert(`${row.name} synced.\n\nBilling/config enrichment:\n${enrichmentAlertLines(report).join("\n")}`);
      }
      return { ok: true, report };
    } catch { alert("Sync failed"); return { ok: false, report: null }; } finally { setStagingId(null); }
  }

  // Sync every non-migrated dealer in a group, sequentially (the ETL box
  // mutexes concurrent syncs; one at a time also gives per-row progress).
  async function syncGroup(groupId: string, groupName: string | null) {
    const allMembers = (data?.rows ?? []).filter((r) => r.groupId === groupId && r.inviteStatus !== "migrated");
    const lockedSkipped = allMembers.filter((m) => m.etlLocked).length;
    const members = allMembers.filter((m) => !m.etlLocked);
    if (members.length === 0) {
      if (lockedSkipped > 0) alert(`${groupName ?? "Group"}: nothing to sync — all ${lockedSkipped} member${lockedSkipped === 1 ? " is" : "s are"} ETL-locked (5.0 config is hand-managed).`);
      return;
    }
    const resynced = members.filter((m) => m.lastSyncedAt).length;
    const warn = resynced > 0 ? ` ${resynced} of them were already synced — their V5.0 logo, products, and settings will be overwritten with current 4.0 data.` : "";
    if (!confirm(`Sync all ${members.length} dealer${members.length === 1 ? "" : "s"} in ${groupName ?? "this group"} from Platform 4.0?${warn}`)) return;
    setSyncingGroup(groupId);
    try {
      const warnings: string[] = [];
      const refusals: string[] = [];
      let syncedCount = 0;
      for (const m of members) {
        const { ok, refused, report } = await syncDealerNoConfirm(m, { quiet: true });
        if (!ok) {
          // A per-dealer REFUSAL (e.g. a 4.0 trial, an etl_locked member) is
          // expected in mixed groups — record it and keep syncing the rest.
          // A hard failure (transport / ETL box error) already alerted; stop.
          if (refused) { refusals.push(`${m.name} — ${refused}`); continue; }
          break;
        }
        syncedCount++;
        if (report) {
          for (const line of enrichmentAlertLines(report)) {
            if (line.startsWith("⚠")) warnings.push(`${m.name} — ${line.slice(2)}`);
          }
        }
      }
      if (syncedCount > 0 || refusals.length > 0) {
        alert(
          `${groupName ?? "Group"}: ${syncedCount} dealer${syncedCount === 1 ? "" : "s"} synced.` +
          (lockedSkipped > 0 ? `\n${lockedSkipped} skipped — locked (5.0 config hand-managed).` : "") +
          (refusals.length ? `\n\nSkipped (refused):\n${refusals.join("\n")}` : "") +
          (warnings.length ? `\n\nEnrichment warnings:\n${warnings.join("\n")}` : (syncedCount > 0 ? "\n\nNo enrichment warnings." : ""))
        );
      }
      await load();
    } finally { setSyncingGroup(null); }
  }

  async function markFbStopped(row: Row, stopped: boolean) {
    try {
      const res = await fetch("/api/migration/freshbooks-stopped", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerId: row.id, stopped }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Update failed"); return; }
      setData((d) => d && { ...d, rows: d.rows.map((r) => r.id === row.id ? { ...r, freshbooksStoppedAt: j.freshbooks_stopped_at, freshbooksStopPending: r.inviteStatus === "migrated" && !j.freshbooks_stopped_at && !r.isNative } : r) });
    } catch { alert("Update failed"); }
  }

  async function assignSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const assignTo = assignTarget === "me" ? me : assignTarget === "unassign" ? null : assignTarget;
    setAssigning(true);
    try {
      const res = await fetch("/api/migration/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerIds: ids, assignTo }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Assign failed"); return; }
      setSelected(new Set());
      await load();
    } catch { alert("Assign failed"); } finally { setAssigning(false); }
  }

  async function claimNext() {
    setClaiming(true);
    try {
      const res = await fetch("/api/migration/claim-next", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 25 }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Claim failed"); return; }
      alert(j.claimed > 0 ? `Claimed ${j.claimed} dealer${j.claimed === 1 ? "" : "s"} to your batch.` : (j.note ?? "Nothing to claim."));
      setAssignFilter("me");
      await load();
    } catch { alert("Claim failed"); } finally { setClaiming(false); }
  }

  // Claim an entire group as one unit so the group always has a single owner.
  // assignTo omitted → me; a UUID → that operator (super_admin "Assign to…").
  // Acts on ALL of the group's un-migrated dealers (full set, not the filtered
  // view) and reuses /api/migration/assign (bulk assign by IDs). Confirms when
  // some members are already owned by someone else.
  async function claimGroup(groupId: string, groupName: string | null, assignTo?: string) {
    const members = (data?.rows ?? []).filter((r) => r.groupId === groupId);
    if (members.length === 0) return;
    const target = assignTo ?? me;
    const destName = assignTo ? (opName(assignTo) ?? "that staff member") : "you";
    const conflicting = members.filter((m) => m.assignedTo && m.assignedTo !== target);
    if (conflicting.length > 0) {
      const owners = Array.from(new Set(conflicting.map((m) => opName(m.assignedTo) ?? "—")));
      const who = owners.length === 1 ? owners[0] : `${owners.length} different people`;
      if (!confirm(`${conflicting.length} dealer${conflicting.length === 1 ? "" : "s"} in ${groupName ?? "this group"} ${conflicting.length === 1 ? "is" : "are"} assigned to ${who}. Reassign all ${members.length} to ${destName}?`)) return;
    } else if (assignTo) {
      if (!confirm(`Assign all ${members.length} dealer${members.length === 1 ? "" : "s"} in ${groupName ?? "this group"} to ${destName}?`)) return;
    }
    setClaimingGroup(groupId);
    try {
      const body = assignTo ? { dealerIds: members.map((m) => m.id), assignTo } : { dealerIds: members.map((m) => m.id) };
      const res = await fetch("/api/migration/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Claim group failed"); return; }
      if (!assignTo) setAssignFilter("me");
      await load();
    } catch { alert("Claim group failed"); } finally { setClaimingGroup(null); }
  }

  const toggleConfirmed = async (row: Row) => {
    if (!data?.flagsColumnPresent) return;
    setSavingId(row.id);
    const next = !row.templateConfirmed;
    try {
      const res = await fetch("/api/migration/template-confirmed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealerId: row.id, confirmed: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      // recompute ready locally — HARD gates only: billing && confirmed && eligible
      setData((d) => d && {
        ...d,
        rows: d.rows.map((r) => r.id === row.id
          ? { ...r, templateConfirmed: next, ready: r.synced && r.billingStaged && next && r.eligible }
          : r),
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  };

  const groups = useMemo(() => {
    const s = new Set<string>();
    data?.rows.forEach((r) => { if (r.groupName) s.add(r.groupName); });
    return Array.from(s).sort();
  }, [data]);
  const states = useMemo(() => {
    const s = new Set<string>();
    data?.rows.forEach((r) => { if (r.state) s.add(r.state); });
    return Array.from(s).sort();
  }, [data]);

  const filtered = useMemo(() => {
    let rows = data?.rows ?? [];
    if (readyOnly) rows = rows.filter((r) => r.ready);
    if (fbPending) rows = rows.filter((r) => r.freshbooksStopPending);
    if (stagedOnly) rows = rows.filter((r) => r.synced);
    // FB stop pending is a global cleanup queue, not per-operator work — when
    // it's checked, ignore the assignment filter (which defaults to "Me" and
    // would hide unassigned migrated dealers).
    if (!fbPending) {
      if (assignFilter === "me") rows = rows.filter((r) => r.assignedTo === me);
      else if (assignFilter === "unassigned") rows = rows.filter((r) => !r.assignedTo);
      else if (assignFilter) rows = rows.filter((r) => r.assignedTo === assignFilter);
    }
    if (statusFilter) {
      rows = rows.filter((r) => r.inviteStatus === statusFilter);
    } else if (!fbPending && !search.trim()) {
      // Default view ("All — except migrated", 2026-08-10): completed dealers
      // — including 5.0 natives, which carry inviteStatus 'migrated' — would
      // drown the working set as migrations reach the hundreds. They stay
      // reachable three ways: the explicit Migrated status option, the FB
      // stop pending queue (migrated AND needing action), and typed search
      // (searching implies intent, so it looks at everything).
      rows = rows.filter((r) => r.inviteStatus !== "migrated");
    }
    if (group) rows = rows.filter((r) => r.groupName === group);
    if (state) rows = rows.filter((r) => r.state === state);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.dealer_id.toLowerCase().includes(q) || (r.groupName ?? "").toLowerCase().includes(q));
    }
    return rows;
  }, [data, readyOnly, fbPending, stagedOnly, assignFilter, me, statusFilter, group, state, search]);

  // Full (unfiltered) group membership — claim-group acts on every un-migrated
  // dealer in the group, even ones the current filters hide.
  const fullGroupMembers = useMemo(() => {
    const m = new Map<string, Row[]>();
    (data?.rows ?? []).forEach((r) => { if (r.groupId) { const a = m.get(r.groupId) ?? []; a.push(r); m.set(r.groupId, a); } });
    return m;
  }, [data]);

  // Render blocks: cluster each group's visible rows under one header (at the
  // group's first appearance in the filtered list); standalone dealers stay inline.
  const blocks = useMemo(() => {
    const seen = new Set<string>();
    const out: ({ kind: "solo"; row: Row } | { kind: "group"; groupId: string; groupName: string | null; shown: Row[] })[] = [];
    for (const r of filtered) {
      if (!r.groupId) { out.push({ kind: "solo", row: r }); continue; }
      if (seen.has(r.groupId)) continue;
      seen.add(r.groupId);
      out.push({ kind: "group", groupId: r.groupId, groupName: r.groupName, shown: filtered.filter((x) => x.groupId === r.groupId) });
    }
    return out;
  }, [filtered]);

  // "My batch" — dealers assigned to me, by stage.
  const myBatch = useMemo(() => {
    const mine = (data?.rows ?? []).filter((r) => r.assignedTo && r.assignedTo === me);
    return {
      total: mine.length,
      ready: mine.filter((r) => r.ready).length,
      invited: mine.filter((r) => r.inviteStatus === "invited" || r.inviteStatus === "stalled" || r.inviteStatus === "expired").length,
      migrated: mine.filter((r) => r.inviteStatus === "migrated" && !r.isNative).length,
    };
  }, [data, me]);

  // live summary recomputed from rows so toggling template-confirmed updates the cards
  const live = useMemo(() => {
    const rows = data?.rows ?? [];
    return {
      total: rows.length,
      ready: rows.filter((r) => r.ready).length,
      eligible: rows.filter((r) => r.eligible).length,
      billingStaged: rows.filter((r) => r.billingStaged && r.billingApplicable !== false).length,
      templateConfirmed: rows.filter((r) => r.templateConfirmed).length,
      readyPool: rows.filter((r) => r.billingStaged && r.eligible).length,
      invited: rows.filter((r) => r.inviteStatus === "invited").length,
      stalled: rows.filter((r) => r.inviteStatus === "stalled" || r.inviteStatus === "expired").length,
      migrated: rows.filter((r) => r.inviteStatus === "migrated" && !r.isNative).length,
      fbPending: rows.filter((r) => r.freshbooksStopPending).length,
      staged: rows.filter((r) => r.synced).length,
      unassigned: rows.filter((r) => r.eligible && !r.assignedTo).length,
    };
  }, [data]);

  const toggleSelect = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function sendWave() {
    // Invite only the READY subset of the selection (server blocks the rest anyway).
    const ids = (data?.rows ?? []).filter((r) => selected.has(r.id) && r.ready).map((r) => r.id);
    if (ids.length === 0) { alert("No Ready dealers selected."); return; }
    if (ids.length > CAP) { alert(`${ids.length} ready selected — over the cap of ${CAP}. Deselect some.`); return; }
    if (!confirm(`Send migration invites to ${ids.length} dealer${ids.length === 1 ? "" : "s"}? Each gets a one-time code to self-migrate. This does NOT change their billing.`)) return;
    setSending(true); setWaveResult(null);
    try {
      const res = await fetch("/api/migration/send-wave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerIds: ids }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Wave failed"); return; }
      setWaveResult({ summary: j.summary, failed: j.failed ?? [], blocked: j.blocked ?? [] });
      setSelected(new Set());
      await load(); // refresh
    } catch (e) { alert(e instanceof Error ? e.message : "Wave failed"); } finally { setSending(false); }
  }

  if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading readiness…</p>;
  if (err) return <p style={{ color: "#c62828", fontSize: 14 }}>Error: {err}</p>;
  if (!data) return null;

  const s = live;
  const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "12px 16px", minWidth: 120 };
  const num: React.CSSProperties = { fontSize: 22, fontWeight: 700, color: "var(--navy, #2a2b3c)" };
  const lbl: React.CSSProperties = { fontSize: 12, color: "var(--text-muted, #78828c)", marginTop: 2 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "#333", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" };
  const warnChip: React.CSSProperties = { background: "#fff8e1", color: "#8a6d00", border: "1px solid #ffe082", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" };

  // One dealer <tr>. Shared by solo dealers and group-clustered members.
  const renderDealerRow = (r: Row, grouped = false) => (
    <tr key={r.id} style={{ background: r.ready ? "#f4fbf4" : undefined }}>
      <td style={{ ...td, textAlign: "center" }}>
        <input type="checkbox" checked={selected.has(r.id)} disabled={r.inviteStatus === "migrated"}
          onChange={() => toggleSelect(r.id)}
          title={r.inviteStatus === "migrated" ? "Already migrated" : "Select to assign and/or invite"}
          style={{ cursor: r.inviteStatus === "migrated" ? "not-allowed" : "pointer" }} />
      </td>
      <td style={td}>
        <div style={{ fontWeight: 600, paddingLeft: grouped ? 16 : 0 }}>{r.name}</div>
        <div style={{ fontSize: 11, color: "#9aa0a6", paddingLeft: grouped ? 16 : 0 }}>{r.dealer_id}</div>
      </td>
      <td style={td}>
        {r.assignedTo
          ? <span style={{ fontSize: 12, fontWeight: r.assignedTo === me ? 600 : 400, color: r.assignedTo === me ? "#1565c0" : "#55595c" }}>{opName(r.assignedTo)}</span>
          : <span style={{ color: "#9aa0a6", fontSize: 12 }}>Unassigned</span>}
      </td>
      <td style={td}>{r.groupName ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
      <td style={td}>{r.state ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
      <td style={{ ...td, textAlign: "center" }}>
        {r.billingApplicable === false
          ? <span title={r.billingReason} style={{ color: "#78828c", fontWeight: 700 }}>—</span>
          : <Check ok={r.billingStaged} title={r.billingReason} />}
      </td>
      <td style={{ ...td, textAlign: "center" }}>
        <input
          type="checkbox"
          checked={r.templateConfirmed}
          disabled={!data.flagsColumnPresent || savingId === r.id}
          onChange={() => void toggleConfirmed(r)}
          title={data.flagsColumnPresent ? "Operator: template applied + reviewed" : "Apply migration 100 to enable"}
          style={{ cursor: data.flagsColumnPresent ? "pointer" : "not-allowed" }}
        />
      </td>
      <td style={{ ...td, textAlign: "center" }}><Check ok={r.eligible} title={r.eligibleReason} /></td>
      <td style={{ ...td, textAlign: "center" }}>
        {r.ready
          ? <span style={{ background: "#2e7d32", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20 }}>READY</span>
          : <span style={{ color: "#9aa0a6", fontSize: 12 }}>—</span>}
      </td>
      <td style={td}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {r.isNative
            ? <span title="Created on Platform 5.0 — never lived on 4.0; nothing was migrated" style={{ background: "#e8eaf6", color: "#3949ab", border: "1px solid #c5cae9", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>5.0 native</span>
            : <StatusBadge status={r.inviteStatus} invitedAt={r.invitedAt} recipients={r.inviteRecipients} />}
          {(r.inviteStatus === "invited" || r.inviteStatus === "stalled" || r.inviteStatus === "expired") && (
            <button type="button" onClick={() => void resend(r)} disabled={resendingId === r.id}
              title="Resend the migration invite (fresh code)"
              style={{ fontSize: 11, color: "#1976d2", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
              {resendingId === r.id ? "…" : "resend"}
            </button>
          )}
          {r.etlLocked ? (
            /* etl_locked: 5.0 config is the hand-managed truth — nothing to
               sync (the ETL refuses these by design), so no dead sync link. */
            <span title="ETL-locked: 5.0 config is hand-managed; Aurora sync is deliberately disabled. Satisfies the Synced gate — there is nothing to pull."
              style={{ background: "#ede7f6", color: "#5e35b1", border: "1px solid #d1c4e9", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" }}>
              🔒 Frozen — counts as synced
            </span>
          ) : (
            <>
              {r.synced && (
                <span title={r.lastSyncedAt
                  ? `Synced from Platform 4.0 on ${new Date(r.lastSyncedAt).toLocaleDateString()} — products, logo, and settings pulled; nothing overwrites them now`
                  : "Prepared before the sync model (staged) — counts as synced"}
                  style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" }}>
                  ✓ Synced{r.lastSyncedAt ? ` ${new Date(r.lastSyncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </span>
              )}
              {r.inviteStatus !== "migrated" && (
                <button type="button" onClick={() => void syncDealer(r)} disabled={stagingId === r.id || syncingGroup !== null}
                  title={r.lastSyncedAt
                    ? "Re-sync — overwrites this dealer's V5.0 logo, products, and settings with current Platform 4.0 data"
                    : "Sync — pulls this dealer's current Platform 4.0 data (products, logo, settings) into 5.0"}
                  style={{ fontSize: 11, color: "#1976d2", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                  {stagingId === r.id ? "syncing…" : r.lastSyncedAt ? "re-sync" : "sync"}
                </button>
              )}
            </>
          )}
        </div>
        {/* FreshBooks tracking is a 4.0->5.0 migration concept — natives never had FreshBooks. */}
        {r.inviteStatus === "migrated" && !r.isNative && (
          <div style={{ fontSize: 11, marginTop: 4 }}>
            {r.freshbooksStoppedAt
              ? <span style={{ color: "#2e7d32" }} title={`stopped ${new Date(r.freshbooksStoppedAt).toLocaleString()}`}>FreshBooks stopped ✓ <button type="button" onClick={() => void markFbStopped(r, false)} style={{ fontSize: 10, color: "#9aa0a6", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>undo</button></span>
              : <span style={{ color: "#b06a00" }}>FreshBooks stop pending <button type="button" onClick={() => void markFbStopped(r, true)} style={{ fontSize: 11, color: "#1976d2", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>mark stopped</button></span>}
          </div>
        )}
      </td>
      <td style={{ ...td, textAlign: "center" }}>
        {r.warnings.length === 0
          ? <span style={{ color: "#cfd8dc" }}>—</span>
          : <span title={`Non-blocking: ${r.warnings.join(", ")}`} style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
              {r.logoMissing && <span style={warnChip}>no logo</span>}
              {r.settingsMissing && <span style={warnChip}>no settings</span>}
              {r.zeroInventory && <span style={warnChip}>no products</span>}
            </span>}
      </td>
    </tr>
  );

  // Group header <tr> — name + counts + ownership summary + claim/assign actions.
  const renderGroupHeader = (groupId: string, groupName: string | null, shownCount: number) => {
    const members = fullGroupMembers.get(groupId) ?? [];
    const owners = new Map<string, number>();
    let unassigned = 0;
    members.forEach((m) => { if (m.assignedTo) owners.set(m.assignedTo, (owners.get(m.assignedTo) ?? 0) + 1); else unassigned++; });
    const ownerParts = Array.from(owners.entries()).map(([id, n]) => `${opName(id)} ×${n}`);
    if (unassigned) ownerParts.push(`unassigned ×${unassigned}`);
    const allMine = members.length > 0 && owners.size === 1 && owners.has(me) && unassigned === 0;
    const busy = claimingGroup === groupId;
    // Group fully on 5.0 (every member migrated or 5.0-native) → nothing left
    // to migrate; show an inert state instead of "Migrate group…". All-native
    // groups (born on 5.0) additionally have no Aurora counterpart, so "Sync
    // group" is meaningless — hide it.
    const allOn50 = members.length > 0 && members.every((m) => m.inviteStatus === "migrated");
    const allNative = members.length > 0 && members.every((m) => m.isNative);
    return (
      <tr key={`g-${groupId}`} style={{ background: "#eef3fb" }}>
        <td colSpan={11} style={{ padding: "8px 10px", borderBottom: "1px solid #d6e1f2", borderTop: "2px solid #d6e1f2" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: NAVY, fontSize: 13 }}>▦ {groupName ?? "Group"}</span>
            <span style={{ fontSize: 12, color: "#78828c" }}>
              {members.length} dealer{members.length === 1 ? "" : "s"}
              {(() => {
                // Counts come from the FULL member list (fullGroupMembers), so
                // rows hidden by the default except-migrated filter can't skew
                // them — this hint just makes the hidden set explicit.
                const migratedN = members.filter((m) => m.inviteStatus === "migrated").length;
                return migratedN > 0 ? ` · ${migratedN} migrated` : "";
              })()}
              {shownCount !== members.length ? ` · ${shownCount} shown` : ""}
            </span>
            <span style={{ fontSize: 12, color: allMine ? "#2e7d32" : "#55595c" }}>
              {allMine ? "owned by you" : `owner: ${ownerParts.join(", ")}`}
            </span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              {!allNative && (
                <button type="button" onClick={() => void syncGroup(groupId, groupName)} disabled={busy || syncingGroup !== null}
                  title="Pull every member dealer's current Platform 4.0 data (products, logo, settings) into 5.0"
                  style={{ height: 28, padding: "0 12px", border: "1px solid #2e7d32", borderRadius: 6, background: "#fff", color: "#2e7d32", fontSize: 12, fontWeight: 600, cursor: syncingGroup ? "default" : "pointer", opacity: syncingGroup && syncingGroup !== groupId ? 0.5 : 1 }}>
                  {syncingGroup === groupId ? "Syncing…" : "Sync group"}
                </button>
              )}
              <button type="button" onClick={() => setInviteAdminsGroup({ id: groupId, name: groupName ?? "Group" })}
                title="Invite this group's admin(s) to set up their Platform 5.0 login"
                style={{ height: 28, padding: "0 12px", border: "1px solid #7b1fa2", borderRadius: 6, background: "#fff", color: "#7b1fa2", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Invite admins…
              </button>
              {allOn50
                ? <span title={allNative ? "Every member was created on 5.0 — nothing to migrate" : "Every active member is on 5.0"}
                    style={{ height: 28, display: "inline-flex", alignItems: "center", padding: "0 12px", borderRadius: 6, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", fontSize: 12, fontWeight: 700 }}>
                    ✓ Group on 5.0
                  </span>
                : <button type="button" onClick={() => setMigrateGroup({ id: groupId, name: groupName ?? "Group" })}
                    title="Migrate every member dealer + take the group's da-billing customer Live (guarded checklist)"
                    style={{ height: 28, padding: "0 12px", border: "none", borderRadius: 6, background: NAVY, color: "#ffa500", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    Migrate group…
                  </button>}
              <button type="button" onClick={() => void claimGroup(groupId, groupName)} disabled={busy}
                title="Assign every dealer in this group to you (one owner per group)"
                style={{ height: 28, padding: "0 12px", border: "1px solid #1976d2", borderRadius: 6, background: allMine ? "#e3f2fd" : "#fff", color: "#1976d2", fontSize: 12, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Claiming…" : "Claim group"}
              </button>
              <select value="" disabled={busy} onChange={(e) => { const v = e.target.value; e.currentTarget.value = ""; if (v) void claimGroup(groupId, groupName, v); }}
                title="Assign the whole group to a specific staff member"
                style={{ height: 28, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 12, background: "#fff", cursor: busy ? "default" : "pointer" }}>
                <option value="">Assign to…</option>
                {operators.filter((o) => o.id !== me).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div style={{ fontFamily: "’Roboto’, sans-serif" }}>
      {/* Tab bar */}
      {(() => {
        const tabBase: React.CSSProperties = { padding: "8px 20px", fontSize: 13, fontWeight: 600, border: "none", borderRadius: "6px 6px 0 0", cursor: "pointer", background: "transparent", color: "#78828c" };
        const tabActive: React.CSSProperties = { ...tabBase, background: "#fff", color: NAVY, borderBottom: "2px solid #1976d2" };
        return (
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e0e0e0", marginBottom: 16 }}>
            <button type="button" style={activeTab === "readiness" ? tabActive : tabBase} onClick={() => setActiveTab("readiness")}>
              Readiness
            </button>
            <button type="button" style={activeTab === "billing-pending" ? tabActive : tabBase} onClick={() => setActiveTab("billing-pending")}>
              Billing Pending{billingPending.length > 0 ? ` (${billingPending.length})` : ""}
            </button>
          </div>
        );
      })()}

      {activeTab === "readiness" && <>
      {!data.flagsColumnPresent && (
        <div style={{ background: "#fff8e1", border: "1px solid #ffe082", color: "#8a6d00", borderRadius: 6, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
          ⚠️ The <code>template_confirmed</code> column isn’t applied yet — run migration{" "}
          <strong>100_migration_readiness.sql</strong> in the Supabase SQL editor to enable the toggle. The
          rest of the readiness view is live (template-confirmed shows as ✗ for everyone until then).
        </div>
      )}

      {/* Summary cards — HARD-gate definition (ready = billing ∩ template ∩ eligible) */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={cardStyle}><div style={{ ...num, color: "#2e7d32" }}>{s.ready}</div><div style={lbl}>Ready to invite</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#1976d2" }}>{s.readyPool}</div><div style={lbl}>One toggle from ready<br /><span style={{ fontSize: 10 }}>billing ∩ eligible</span></div></div>
        <div style={cardStyle}><div style={num}>{s.total}</div><div style={lbl}>Un-migrated dealers</div></div>
        <div style={cardStyle}><div style={num}>{s.eligible}</div><div style={lbl}>Eligible</div></div>
        <div style={cardStyle}><div style={num}>{s.billingStaged}</div><div style={lbl}>Billing staged</div></div>
        <div style={cardStyle}><div style={num}>{s.templateConfirmed}</div><div style={lbl}>Template confirmed</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#1565c0" }}>{s.invited}</div><div style={lbl}>Invited (pending)</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#b06a00" }}>{s.stalled}</div><div style={lbl}>Stalled / expired</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#2e7d32" }}>{s.migrated}</div><div style={lbl}>Migrated</div></div>
        <div style={cardStyle}><div style={{ ...num, color: s.fbPending ? "#c62828" : "#2e7d32" }}>{s.fbPending}</div><div style={lbl}>FreshBooks stop pending</div></div>
      </div>

      {/* Recent waves */}
      {waves.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>Recent waves</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {waves.slice(0, 6).map((w) => (
              <div key={w.waveId} style={{ display: "flex", gap: 12, fontSize: 13, alignItems: "center" }}>
                <span style={{ color: "#78828c", minWidth: 150 }}>{w.sentAt ? new Date(w.sentAt).toLocaleString() : w.waveId}</span>
                <span><strong>{w.sent}</strong> sent</span>
                <span style={{ color: "#2e7d32" }}>{w.migrated} migrated</span>
                <span style={{ color: "#b06a00" }}>{w.pending} pending</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* My batch + Claim next 25 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, background: "#eef6ff", border: "1px solid #bcdcff", borderRadius: 8, padding: "10px 14px", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: NAVY }}>My batch</span>
        <span style={{ fontSize: 13, color: "#55595c" }}>{myBatch.total} assigned · <strong style={{ color: "#2e7d32" }}>{myBatch.ready} ready</strong> · {myBatch.invited} invited · {myBatch.migrated} migrated</span>
        <span style={{ fontSize: 12, color: "#78828c" }}>· {s.unassigned} unassigned eligible</span>
        <button type="button" onClick={claimNext} disabled={claiming}
          title="Claim the next 25 unassigned eligible STANDALONE dealers (one-toggle-from-ready first). Group dealers are claimed per-group from the group header."
          style={{ marginLeft: "auto", height: 32, padding: "0 16px", border: "none", borderRadius: 6, background: claiming ? "#9bbfe6" : "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: claiming ? "default" : "pointer" }}>
          {claiming ? "Claiming…" : "Claim next 25 (standalone)"}
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / ID / group…"
          style={{ height: 34, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13, minWidth: 240 }} />
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
          <option value="">All states</option>
          {states.map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <select value={assignFilter} onChange={(e) => setAssignFilter(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }} title="Assigned to">
          <option value="">All owners</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
          {operators.filter((o) => o.id !== me).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
          <option value="">All — except migrated</option>
          <option value="not-invited">Not invited</option>
          <option value="invited">Invited</option>
          <option value="stalled">Stalled</option>
          <option value="expired">Expired</option>
          <option value="migrated">Migrated</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }}>
          <input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} /> Ready only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }} title="Migrated dealers whose FreshBooks recurring still needs stopping — shows ALL of them (ignores the Assigned-to filter)">
          <input type="checkbox" checked={fbPending} onChange={(e) => setFbPending(e.target.checked)} /> FB stop pending
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }} title="Dealers whose Platform 4.0 data has been pulled into 5.0 via Sync (or staged before the sync model)">
          <input type="checkbox" checked={stagedOnly} onChange={(e) => setStagedOnly(e.target.checked)} /> Synced{live.staged ? ` (${live.staged})` : ""}
        </label>
        <button
          type="button"
          onClick={() => setSelected((prev) => { const n = new Set(prev); const readyVisible = filtered.filter((r) => r.ready); const allSel = readyVisible.length > 0 && readyVisible.every((r) => n.has(r.id)); readyVisible.forEach((r) => allSel ? n.delete(r.id) : n.add(r.id)); return n; })}
          style={{ height: 34, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13, background: "#fff", cursor: "pointer" }}
        >
          Select all Ready (shown)
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted, #78828c)", marginLeft: "auto" }}>
          Showing {filtered.length} of {s.total}
        </span>
      </div>

      {/* Action bar — appears when rows are selected. Assign works on ALL
          selected; Send invites applies to the Ready subset (server blocks the
          rest). */}
      {selected.size > 0 && (() => {
        const selectedReady = (data?.rows ?? []).filter((r) => selected.has(r.id) && r.ready).length;
        const overCap = selectedReady > CAP;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 12, background: overCap ? "#fff3e0" : "#eef6ff", border: `1px solid ${overCap ? "#ffcc80" : "#bcdcff"}`, borderRadius: 8, padding: "10px 14px", marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>{selected.size} selected{selectedReady !== selected.size ? ` (${selectedReady} ready)` : ""}</span>
            {/* Assign */}
            <select value={assignTarget} onChange={(e) => setAssignTarget(e.target.value)} style={{ height: 32, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
              <option value="me">Assign to me</option>
              {operators.filter((o) => o.id !== me).map((o) => <option key={o.id} value={o.id}>Assign to {o.name}</option>)}
              <option value="unassign">Unassign</option>
            </select>
            <button type="button" onClick={assignSelected} disabled={assigning}
              style={{ height: 32, padding: "0 14px", border: "1px solid #1976d2", borderRadius: 6, background: "#fff", color: "#1976d2", fontSize: 13, fontWeight: 600, cursor: assigning ? "default" : "pointer", opacity: assigning ? 0.6 : 1 }}>
              {assigning ? "Assigning…" : "Assign"}
            </button>
            {overCap && <span style={{ fontSize: 12, color: "#b06a00" }}>⚠ {selectedReady} ready &gt; cap {CAP}</span>}
            <button type="button" onClick={() => setSelected(new Set())} style={{ marginLeft: "auto", height: 32, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, background: "#fff", fontSize: 13, cursor: "pointer" }}>Clear</button>
            <button type="button" onClick={sendWave} disabled={sending || selectedReady === 0 || overCap}
              title={selectedReady === 0 ? "No Ready dealers selected" : "Send the 13a OTP invite to selected Ready dealers"}
              style={{ height: 32, padding: "0 16px", border: "none", borderRadius: 6, background: sending || selectedReady === 0 || overCap ? "#9bbfe6" : "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: sending || selectedReady === 0 || overCap ? "default" : "pointer" }}>
              {sending ? "Sending…" : `Send invites (${Math.min(selectedReady, CAP)})`}
            </button>
          </div>
        );
      })()}

      {/* Last wave result */}
      {waveResult && (
        <div style={{ background: "#f1faf2", border: "1px solid #cfe8d2", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#2e7d32" }}>
          Wave sent — <strong>{waveResult.summary.sent}</strong> invited{waveResult.summary.failed ? `, ${waveResult.summary.failed} failed` : ""}{waveResult.summary.blocked ? `, ${waveResult.summary.blocked} blocked (not ready)` : ""}.
          {waveResult.failed.length > 0 && <div style={{ color: "#c62828", marginTop: 4 }}>Failed: {waveResult.failed.map((f) => `${f.name} (${f.error})`).join("; ")}</div>}
          {waveResult.blocked.length > 0 && <div style={{ color: "#b06a00", marginTop: 4 }}>Blocked: {waveResult.blocked.map((b) => `${b.name} (${b.reason})`).join("; ")}</div>}
        </div>
      )}

      {/* Table */}
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 34, textAlign: "center" }} title="Select Ready dealers for a wave"> </th>
              <th style={th}>Dealer</th>
              <th style={th}>Owner</th>
              <th style={th}>Group</th>
              <th style={th}>State</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Billing</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Template</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Eligible</th>
              <th style={{ ...th, textAlign: "center" }}>Ready?</th>
              <th style={{ ...th }}>Invite status</th>
              <th style={{ ...th, textAlign: "center" }} title="Informational — does NOT block Ready">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => b.kind === "solo"
              ? renderDealerRow(b.row)
              : (
                <Fragment key={`block-${b.groupId}`}>
                  {renderGroupHeader(b.groupId, b.groupName, b.shown.length)}
                  {b.shown.map((m) => renderDealerRow(m, true))}
                </Fragment>
              ))}
            {filtered.length === 0 && (
              <tr><td style={{ ...td, textAlign: "center", color: "#9aa0a6" }} colSpan={11}>No dealers match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted, #78828c)", marginTop: 10 }}>{data.note}</p>
      </>}

      {activeTab === "billing-pending" && (() => {
        const bpTh: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
        const bpTd: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "#333", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" };
        return (
          <div>
            {bpErr && (
              <div style={{ background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 8, padding: "12px 16px", fontSize: 13, marginBottom: 12 }}>
                {bpErr}
              </div>
            )}
            {billingPending.length === 0
              ? (
                <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "24px 20px", textAlign: "center", color: "#78828c", fontSize: 14 }}>
                  All caught up — no billing activations pending.
                </div>
              )
              : (
                <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={bpTh}>Dealer</th>
                        <th style={bpTh}>Group</th>
                        <th style={bpTh}>Account type</th>
                        <th style={{ ...bpTh, width: 160 }}>Billing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {billingPending.map((r) => {
                        const aState = activateStates[r.id] ?? { status: "idle" };
                        return (
                          <tr key={r.id}>
                            <td style={bpTd}>
                              <div style={{ fontWeight: 600 }}>{r.name}</div>
                              <div style={{ fontSize: 11, color: "#9aa0a6" }} title={`Billing customer ${r.billing_customer_id ?? ""}`}>{r.billing_customer_id ?? "—"}</div>
                            </td>
                            <td style={bpTd}>{r.group_name ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                            <td style={bpTd}>{r.account_type ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                            <td style={bpTd}>
                              {aState.status === "done"
                                ? <span style={{ color: "#2e7d32", fontWeight: 600, fontSize: 13 }}>✓ Activated</span>
                                : aState.status === "error"
                                  ? <span style={{ color: "#c62828", fontSize: 12 }} title={aState.message}>Error: {aState.message}</span>
                                  : (
                                    <button
                                      type="button"
                                      disabled={aState.status === "loading"}
                                      onClick={() => void activateBilling(r.id)}
                                      style={{
                                        height: 30,
                                        padding: "0 14px",
                                        border: "none",
                                        borderRadius: 6,
                                        backgroundColor: aState.status === "loading" ? "#9bbfe6" : "#1976d2",
                                        color: "#fff",
                                        fontSize: 12,
                                        fontWeight: 600,
                                        cursor: aState.status === "loading" ? "default" : "pointer",
                                      }}
                                    >
                                      {aState.status === "loading" ? "Activating…" : "Activate Billing"}
                                    </button>
                                  )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        );
      })()}

      {inviteAdminsGroup && (
        <InviteAdminsModal group={inviteAdminsGroup} onClose={() => setInviteAdminsGroup(null)} />
      )}
      {migrateGroup && (
        <MigrateGroupModal
          group={migrateGroup}
          memberRows={(data?.rows ?? []).filter((r) => r.groupId === migrateGroup.id)}
          onClose={() => setMigrateGroup(null)}
          onMigrated={() => { setMigrateGroup(null); void load(); }}
        />
      )}
    </div>
  );
}

// ── Group-admin invite modal ─────────────────────────────────────────────────
type AdminCandidate = { id: string; email: string; full_name: string | null; active: boolean; has_auth: boolean; last_sign_in: string | null };
type AdminsResp = {
  group: { id: string; name: string };
  admins: AdminCandidate[];
  pending: Array<{ email: string; first_name: string | null; last_name: string | null; created_at: string; expires_at: string }>;
  suggested: { email: string; name: string | null; source: string } | null;
  admin_active: boolean;
};

const modalOverlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const modalBox: React.CSSProperties = { background: "#fff", borderRadius: 8, padding: 24, width: 520, maxHeight: "84vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", fontFamily: "'Roboto', sans-serif" };

function adminStatusChip(a: AdminCandidate): React.ReactNode {
  if (a.last_sign_in) return <span style={{ fontSize: 11, fontWeight: 700, color: "#2e7d32" }}>Active ✓ · signed in {new Date(a.last_sign_in).toLocaleDateString()}</span>;
  if (a.has_auth) return <span style={{ fontSize: 11, fontWeight: 700, color: "#b06a00" }}>Has login · never signed in — can re-invite</span>;
  return <span style={{ fontSize: 11, fontWeight: 700, color: "#c62828" }}>No 5.0 login</span>;
}

function InviteAdminsModal({ group, onClose }: { group: { id: string; name: string }; onClose: () => void }) {
  const [info, setInfo] = useState<AdminsResp | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set()); // emails
  const [manual, setManual] = useState({ first: "", last: "", email: "" });
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Array<{ email: string; status: string; detail?: string }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/migration/group-admins?group_id=${encodeURIComponent(group.id)}`);
        const j = await res.json();
        if (!cancelled) { if (res.ok) setInfo(j as AdminsResp); else setLoadErr(j.error ?? "Failed to load"); }
      } catch { if (!cancelled) setLoadErr("Failed to load"); }
    })();
    return () => { cancelled = true; };
  }, [group.id]);

  function toggle(email: string) {
    setChecked((prev) => { const n = new Set(prev); if (n.has(email)) n.delete(email); else n.add(email); return n; });
  }

  async function send() {
    if (!info) return;
    const invites: Array<{ first_name: string; last_name: string; email: string }> = [];
    for (const email of Array.from(checked)) {
      const a = info.admins.find((x) => x.email === email);
      const sug = info.suggested?.email === email ? info.suggested : null;
      const name = (a?.full_name ?? sug?.name ?? "").trim();
      const [first, ...rest] = name.split(/\s+/);
      invites.push({ first_name: first ?? "", last_name: rest.join(" "), email });
    }
    if (manual.email.trim()) invites.push({ first_name: manual.first.trim(), last_name: manual.last.trim(), email: manual.email.trim().toLowerCase() });
    if (invites.length === 0) return;
    setSending(true);
    try {
      const res = await fetch("/api/migration/group-admins", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: group.id, invites }),
      });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Invite failed"); return; }
      setResults(j.results ?? []);
    } catch { alert("Invite failed"); } finally { setSending(false); }
  }

  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: NAVY, marginBottom: 4 }}>Invite admins — {group.name}</div>
        <p style={{ fontSize: 12, color: "#78828c", margin: "0 0 14px" }}>
          Sends the scanner-proof 5.0 setup invite (8-digit code). Migrating the group requires at least one admin to have signed in.
        </p>
        {loadErr && <div style={{ color: "#c62828", fontSize: 13 }}>{loadErr}</div>}
        {!info && !loadErr && <div style={{ color: "#78828c", fontSize: 13 }}>Loading…</div>}
        {info && !results && (
          <>
            {info.admins.length === 0 && !info.suggested && (
              <div style={{ fontSize: 13, color: "#78828c", marginBottom: 10 }}>
                No group_admin profiles on file for this group — add the admin below. (No live Aurora lookup here; the profiles ETL sync was retired, so legacy-only group users are added by email.)
              </div>
            )}
            {info.admins.map((a) => (
              // Only a user who has actually SIGNED IN is non-selectable — they
              // already have working credentials. "Has an auth user but never
              // signed in" is invitable (the common case for shuffled legacy
              // admins who don't know their credentials).
              <label key={a.email} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 4px", borderBottom: "1px solid #f0f0f0", cursor: a.last_sign_in ? "default" : "pointer" }}>
                <input type="checkbox" disabled={!!a.last_sign_in} checked={checked.has(a.email)} onChange={() => toggle(a.email)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>{a.full_name || a.email}</span>
                  <span style={{ display: "block", fontSize: 11, color: "#78828c" }}>{a.email}</span>
                </span>
                {adminStatusChip(a)}
              </label>
            ))}
            {info.suggested && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 4px", borderBottom: "1px solid #f0f0f0", cursor: "pointer" }}>
                <input type="checkbox" checked={checked.has(info.suggested.email)} onChange={() => toggle(info.suggested!.email)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>{info.suggested.name || info.suggested.email}</span>
                  <span style={{ display: "block", fontSize: 11, color: "#78828c" }}>{info.suggested.email} · {info.suggested.source}</span>
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#78828c" }}>Suggested</span>
              </label>
            )}
            {info.pending.length > 0 && (
              <div style={{ fontSize: 11, color: "#b06a00", margin: "8px 0 0" }}>
                Pending: {info.pending.map((p) => `${p.email} (invited ${new Date(p.created_at).toLocaleDateString()})`).join(", ")}
              </div>
            )}
            <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid #e0e0e0" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#55595c", textTransform: "uppercase", marginBottom: 6 }}>Add someone else</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input placeholder="First" value={manual.first} onChange={(e) => setManual({ ...manual, first: e.target.value })} style={{ width: 90, padding: "6px 8px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13 }} />
                <input placeholder="Last" value={manual.last} onChange={(e) => setManual({ ...manual, last: e.target.value })} style={{ width: 90, padding: "6px 8px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13 }} />
                <input placeholder="email@dealer.com" value={manual.email} onChange={(e) => setManual({ ...manual, email: e.target.value })} style={{ flex: 1, padding: "6px 8px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 16px", border: "1px solid #cccccc", borderRadius: 6, background: "#fff", fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button type="button" onClick={() => void send()} disabled={sending || (checked.size === 0 && !manual.email.trim())}
                style={{ padding: "8px 16px", border: "none", borderRadius: 6, background: "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: sending || (checked.size === 0 && !manual.email.trim()) ? 0.5 : 1 }}>
                {sending ? "Sending…" : "Send invites"}
              </button>
            </div>
          </>
        )}
        {results && (
          <>
            {results.map((r) => (
              <div key={r.email} style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
                <span style={{ fontWeight: 600 }}>{r.email}</span>{" — "}
                <span style={{ color: r.status === "sent" ? "#2e7d32" : r.status === "skipped" ? "#b06a00" : "#c62828" }}>
                  {r.status}{r.detail ? ` (${r.detail})` : ""}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 16px", border: "none", borderRadius: 6, background: "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Migrate-group modal ──────────────────────────────────────────────────────
function MigrateGroupModal({ group, memberRows, onClose, onMigrated }: {
  group: { id: string; name: string };
  memberRows: Row[];
  onClose: () => void;
  onMigrated: () => void;
}) {
  const [adminInfo, setAdminInfo] = useState<AdminsResp | null>(null);
  const [activateBilling, setActivateBilling] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ migrated: string[]; skipped: Array<{ name: string; reason: string }>; billing: string; failed: Array<{ name: string; error: string }> } | null>(null);
  const [runErr, setRunErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/migration/group-admins?group_id=${encodeURIComponent(group.id)}`);
        const j = await res.json();
        if (!cancelled && res.ok) setAdminInfo(j as AdminsResp);
      } catch { /* checklist shows unknown */ }
    })();
    return () => { cancelled = true; };
  }, [group.id]);

  // Client mirror of the server gate: migrated OR synced+billing+template.
  // Self-serve ELIGIBILITY is deliberately NOT required — group-managed
  // dealers migrate through this path. The server re-checks everything.
  const memberChecks = memberRows.map((r) => {
    const missing: string[] = [];
    if (r.inviteStatus !== "migrated") {
      if (!r.synced) missing.push("not synced");
      if (!r.billingStaged) missing.push("billing");
      if (!r.templateConfirmed) missing.push("template");
    }
    return { name: r.name, migrated: r.inviteStatus === "migrated", missing };
  });
  const membersOk = memberChecks.every((m) => m.missing.length === 0);
  const adminOk = adminInfo?.admin_active === true;
  const canRun = membersOk && adminOk && !running;

  async function run() {
    setRunning(true);
    setRunErr("");
    try {
      const res = await fetch("/api/migration/migrate-group", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: group.id, activate_billing: activateBilling }),
      });
      const j = await res.json();
      if (!res.ok) {
        setRunErr(j.blockers ? `${j.error} ${j.blockers.map((b: { name: string; missing: string[] }) => `${b.name}: ${b.missing.join(", ")}`).join("; ")}` : (j.error ?? "Migration failed"));
        return;
      }
      setResult(j);
    } catch { setRunErr("Migration failed"); } finally { setRunning(false); }
  }

  return (
    <div style={modalOverlay} onClick={result ? onMigrated : onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: NAVY, marginBottom: 4 }}>Migrate group — {group.name}</div>
        {!result && (
          <>
            <p style={{ fontSize: 12, color: "#78828c", margin: "0 0 14px" }}>
              This migrates every ready member dealer to 5.0 (account → Paid, ETL stops for them), optionally takes the
              group&apos;s da-billing customer <strong>Live</strong>, and queues the manual FreshBooks recurring-stop.
              Rollback is per-dealer via the existing rollback flow.
            </p>
            <div style={{ fontSize: 13, marginBottom: 4, fontWeight: 700, color: "#55595c" }}>Checklist</div>
            <div style={{ fontSize: 13, padding: "5px 0", borderBottom: "1px solid #f0f0f0" }}>
              {adminInfo == null ? "… checking group admin logins" : adminOk
                ? <span style={{ color: "#2e7d32" }}>✓ A group admin has an active 5.0 login</span>
                : <span style={{ color: "#c62828" }}>✗ No group admin has signed in to 5.0 yet — use “Invite admins…” first, then wait for their first sign-in</span>}
            </div>
            {memberChecks.map((m) => (
              <div key={m.name} style={{ fontSize: 13, padding: "5px 0", borderBottom: "1px solid #f0f0f0" }}>
                {m.migrated
                  ? <span style={{ color: "#78828c" }}>— {m.name} (already migrated)</span>
                  : m.missing.length === 0
                    ? <span style={{ color: "#2e7d32" }}>✓ {m.name} — ready</span>
                    : <span style={{ color: "#c62828" }}>✗ {m.name} — {m.missing.join(", ")}</span>}
              </div>
            ))}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={activateBilling} onChange={(e) => setActivateBilling(e.target.checked)} />
              <span>Activate group billing now (da-billing customer goes <strong>Live</strong>; next invoice date stays in the future — nothing is charged today)</span>
            </label>
            {runErr && <div style={{ color: "#c62828", fontSize: 12, marginTop: 10 }}>{runErr}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 16px", border: "1px solid #cccccc", borderRadius: 6, background: "#fff", fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button type="button" onClick={() => void run()} disabled={!canRun}
                style={{ padding: "8px 16px", border: "none", borderRadius: 6, background: NAVY, color: "#ffa500", fontSize: 13, fontWeight: 700, cursor: canRun ? "pointer" : "default", opacity: canRun ? 1 : 0.5 }}>
                {running ? "Migrating…" : "Migrate group"}
              </button>
            </div>
          </>
        )}
        {result && (
          <>
            <div style={{ fontSize: 13, color: "#2e7d32", fontWeight: 600, margin: "8px 0" }}>✓ Migrated {result.migrated.length} dealer{result.migrated.length === 1 ? "" : "s"}: {result.migrated.join(", ")}</div>
            {result.skipped.length > 0 && <div style={{ fontSize: 12, color: "#78828c" }}>Skipped: {result.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}</div>}
            {result.failed.length > 0 && <div style={{ fontSize: 12, color: "#c62828" }}>Failed: {result.failed.map((f) => `${f.name} (${f.error})`).join(", ")}</div>}
            <div style={{ fontSize: 12, color: "#55595c", marginTop: 6 }}>Billing: {result.billing}</div>
            <div style={{ fontSize: 12, color: "#b06a00", marginTop: 6 }}>⚠ FreshBooks recurring-stop is queued as a manual operator task (FB stop pending).</div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={onMigrated} style={{ padding: "8px 16px", border: "none", borderRadius: 6, background: "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
