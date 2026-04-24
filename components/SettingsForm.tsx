"use client";

import { useState, useEffect, useCallback } from "react";
import type { DealerSettingsRow, TemplateRow, UserRole } from "@/lib/db";
import DealerLogoUploader from "@/components/DealerLogoUploader";

type Props = {
  fixedDealerId: string | null;
  role: UserRole;
  groupId: string | null;
  initialSettings: DealerSettingsRow | null;
};

type DealerOption = { dealer_id: string; name: string };

const SETTING_DEFAULTS: Omit<DealerSettingsRow, "dealer_id" | "updated_at"> = {
  ai_content_default: false,
  nudge_left: 0,
  nudge_right: 0,
  nudge_top: 0,
  nudge_bottom: 0,
  default_template_new: null,
  default_template_used: null,
  default_template_cpo: null,
  default_addendum_new: null,
  default_addendum_used: null,
  default_addendum_cpo: null,
  default_infosheet_new: null,
  default_infosheet_used: null,
  default_infosheet_cpo: null,
  default_buyersguide_new: null,
  default_buyersguide_used: null,
  default_buyersguide_cpo: null,
};

type DocTab = "addendum" | "infosheet" | "buyers_guide";

export default function SettingsForm({ fixedDealerId, role, groupId, initialSettings }: Props) {
  const [dealerId, setDealerId] = useState<string | null>(fixedDealerId);
  const [dealerName, setDealerName] = useState<string>("");

  // dealer picker state (for super_admin / group_admin)
  const [dealerQuery, setDealerQuery] = useState("");
  const [dealerResults, setDealerResults] = useState<DealerOption[]>([]);
  const [loadingDealers, setLoadingDealers] = useState(false);

  const [settings, setSettings] = useState<Omit<DealerSettingsRow, "dealer_id" | "updated_at">>(
    initialSettings
      ? {
          ai_content_default: initialSettings.ai_content_default,
          nudge_left: initialSettings.nudge_left,
          nudge_right: initialSettings.nudge_right,
          nudge_top: initialSettings.nudge_top,
          nudge_bottom: initialSettings.nudge_bottom,
          default_template_new: initialSettings.default_template_new,
          default_template_used: initialSettings.default_template_used,
          default_template_cpo: initialSettings.default_template_cpo,
          default_addendum_new: initialSettings.default_addendum_new ?? null,
          default_addendum_used: initialSettings.default_addendum_used ?? null,
          default_addendum_cpo: initialSettings.default_addendum_cpo ?? null,
          default_infosheet_new: initialSettings.default_infosheet_new ?? null,
          default_infosheet_used: initialSettings.default_infosheet_used ?? null,
          default_infosheet_cpo: initialSettings.default_infosheet_cpo ?? null,
          default_buyersguide_new: initialSettings.default_buyersguide_new ?? null,
          default_buyersguide_used: initialSettings.default_buyersguide_used ?? null,
          default_buyersguide_cpo: initialSettings.default_buyersguide_cpo ?? null,
        }
      : { ...SETTING_DEFAULTS }
  );

  const [docTab, setDocTab] = useState<DocTab>("addendum");
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  const isAdminPicker = role === "super_admin" || role === "group_admin";

  // Fetch dealers for picker
  useEffect(() => {
    if (!isAdminPicker) return;
    if (role === "group_admin" && groupId) {
      setLoadingDealers(true);
      fetch(`/api/groups/${groupId}/dealers`)
        .then((r) => r.json() as Promise<{ data: DealerOption[] }>)
        .then((j) => setDealerResults(j.data ?? []))
        .catch(() => {})
        .finally(() => setLoadingDealers(false));
    }
  }, [isAdminPicker, role, groupId]);

  // super_admin: search as user types
  useEffect(() => {
    if (role !== "super_admin") return;
    if (!dealerQuery.trim()) { setDealerResults([]); return; }
    const t = setTimeout(() => {
      setLoadingDealers(true);
      fetch(`/api/dealers?q=${encodeURIComponent(dealerQuery)}&per_page=20`)
        .then((r) => r.json() as Promise<{ data: DealerOption[] }>)
        .then((j) => setDealerResults(j.data ?? []))
        .catch(() => {})
        .finally(() => setLoadingDealers(false));
    }, 300);
    return () => clearTimeout(t);
  }, [dealerQuery, role]);

  const fetchSettingsAndTemplates = useCallback(async (id: string) => {
    const qs = role === "dealer_admin" ? "" : `?dealer_id=${id}`;
    const [sRes, tRes, lRes] = await Promise.all([
      fetch(`/api/settings${qs}`),
      fetch(`/api/templates${qs}`),
      fetch(`/api/dealers/${id}/logo`),
    ]);
    const sJson = await sRes.json() as { data: DealerSettingsRow };
    const tJson = await tRes.json() as { data: TemplateRow[] };
    const lJson = await lRes.json() as { logo_url?: string | null };
    if (sJson.data) {
      setSettings({
        ai_content_default: sJson.data.ai_content_default,
        nudge_left: sJson.data.nudge_left,
        nudge_right: sJson.data.nudge_right,
        nudge_top: sJson.data.nudge_top,
        nudge_bottom: sJson.data.nudge_bottom,
        default_template_new: sJson.data.default_template_new,
        default_template_used: sJson.data.default_template_used,
        default_template_cpo: sJson.data.default_template_cpo,
        default_addendum_new: sJson.data.default_addendum_new ?? null,
        default_addendum_used: sJson.data.default_addendum_used ?? null,
        default_addendum_cpo: sJson.data.default_addendum_cpo ?? null,
        default_infosheet_new: sJson.data.default_infosheet_new ?? null,
        default_infosheet_used: sJson.data.default_infosheet_used ?? null,
        default_infosheet_cpo: sJson.data.default_infosheet_cpo ?? null,
        default_buyersguide_new: sJson.data.default_buyersguide_new ?? null,
        default_buyersguide_used: sJson.data.default_buyersguide_used ?? null,
        default_buyersguide_cpo: sJson.data.default_buyersguide_cpo ?? null,
      });
    }
    setTemplates(tJson.data ?? []);
    setLogoUrl(lJson.logo_url ?? null);
  }, [role]);

  useEffect(() => {
    if (dealerId) fetchSettingsAndTemplates(dealerId);
  }, [dealerId, fetchSettingsAndTemplates]);

  function selectDealer(d: DealerOption) {
    setDealerId(d.dealer_id);
    setDealerName(d.name);
    setDealerResults([]);
    setDealerQuery("");
  }

  async function handleSave() {
    if (!dealerId) return;
    setSaving(true);
    setSaveStatus("idle");
    setError(null);
    const qs = role === "dealer_admin" ? "" : `?dealer_id=${dealerId}`;
    try {
      const res = await fetch(`/api/settings${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const j = await res.json() as { error: string };
        setError(j.error ?? "Save failed");
        setSaveStatus("error");
      } else {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2500);
      }
    } catch {
      setError("Network error");
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  // ── Dealer picker for admin roles ──────────────────────────────────────────
  if (isAdminPicker && !dealerId) {
    return (
      <div className="card p-6" style={{ maxWidth: 480 }}>
        <p className="text-sm font-medium mb-3" style={{ color: "var(--text-secondary)" }}>
          Select a dealer to manage settings
        </p>
        {role === "super_admin" && (
          <input
            className="input w-full mb-2"
            placeholder="Search dealers…"
            value={dealerQuery}
            onChange={(e) => setDealerQuery(e.target.value)}
          />
        )}
        {loadingDealers && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Loading…</p>
        )}
        {dealerResults.length > 0 && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            {dealerResults.map((d) => (
              <button
                key={d.dealer_id}
                className="w-full text-left px-4 py-2 text-sm"
                style={{
                  background: "var(--bg-surface)",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                }}
                onClick={() => selectDealer(d)}
              >
                {d.name}
                <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  {d.dealer_id}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Settings form ──────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 640 }}>
      {isAdminPicker && dealerId && (
        <div className="mb-4 flex items-center gap-3">
          <span className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Editing: <strong style={{ color: "var(--text-primary)" }}>{dealerName || dealerId}</strong>
          </span>
          <button
            className="text-xs"
            style={{ color: "var(--blue)" }}
            onClick={() => { setDealerId(null); setDealerName(""); }}
          >
            Change
          </button>
        </div>
      )}

      {/* Dealer Logo */}
      {(role === "dealer_admin" || isAdminPicker) && dealerId && (
        <div className="card p-5 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Dealer Logo
          </p>
          <DealerLogoUploader
            dealerId={dealerId}
            currentLogoUrl={logoUrl}
            onUpdated={(url) => setLogoUrl(url)}
          />
        </div>
      )}

      {/* AI Content */}
      <div className="card p-5 mb-4">
        <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
          AI Content
        </p>
        <div className="flex items-center gap-4">
          <button
            className="px-4 py-2 text-sm font-medium rounded"
            style={{
              background: !settings.ai_content_default ? "var(--blue)" : "var(--bg-subtle)",
              color: !settings.ai_content_default ? "#fff" : "var(--text-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
            onClick={() => setSettings((s) => ({ ...s, ai_content_default: false }))}
          >
            DB (Database)
          </button>
          <button
            className="px-4 py-2 text-sm font-medium"
            style={{
              background: settings.ai_content_default ? "var(--blue)" : "var(--bg-subtle)",
              color: settings.ai_content_default ? "#fff" : "var(--text-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
            onClick={() => setSettings((s) => ({ ...s, ai_content_default: true }))}
          >
            AI (Claude)
          </button>
        </div>
        <p className="text-xs mt-3" style={{ color: "var(--text-muted)" }}>
          {settings.ai_content_default
            ? "Vehicle descriptions and features will be AI-generated by Claude by default."
            : "Vehicle descriptions and features will use database content by default."}
        </p>
      </div>

      {/* Default Templates */}
      <div className="card mb-4" style={{ overflow: "hidden" }}>
        <div className="p-5 pb-0">
          <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Default Templates
          </p>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 20, gap: 0 }}>
            {([ ["addendum", "Addendum"], ["infosheet", "Infosheet"], ["buyers_guide", "Buyer's Guide"] ] as [DocTab, string][]).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setDocTab(tab)}
                style={{
                  padding: "8px 18px",
                  fontSize: 13,
                  fontWeight: docTab === tab ? 600 : 400,
                  color: docTab === tab ? "var(--blue)" : "var(--text-secondary)",
                  background: "none",
                  border: "none",
                  borderBottom: docTab === tab ? "2px solid var(--blue)" : "2px solid transparent",
                  marginBottom: -1,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 pb-5">
          {docTab === "buyers_guide" ? (
            <p className="text-sm" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
              Buyer&apos;s Guide templates are coming soon. Create them in the Builder once support is added.
            </p>
          ) : (
            <>
              {(["new", "used", "cpo"] as const).map((vtype) => {
                const key = `default_${docTab === "addendum" ? "addendum" : "infosheet"}_${vtype}` as keyof typeof settings;
                const label = vtype === "new" ? "New Vehicles" : vtype === "used" ? "Used Vehicles" : "CPO Vehicles";
                const filtered = templates.filter((t) => t.document_type === docTab);
                return (
                  <div key={vtype} className="flex items-center gap-3 mb-3">
                    <label className="text-sm w-28 flex-shrink-0" style={{ color: "var(--text-secondary)" }}>
                      {label}
                    </label>
                    <select
                      className="input flex-1"
                      value={(settings[key] as string | null) ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value || null }))}
                    >
                      <option value="">— No default —</option>
                      {filtered.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
              {templates.filter((t) => t.document_type === docTab).length === 0 && (
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  No {docTab} templates saved yet. Create them in the Builder.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Printer Nudge Margins */}
      <div className="card p-5 mb-6">
        <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
          Printer Nudge Margins
        </p>
        <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
          Fine-tune print alignment per printer (pixels). Set once, applies to all prints.
        </p>
        <div className="grid grid-cols-2 gap-4">
          {(["left", "right", "top", "bottom"] as const).map((side) => {
            const key = `nudge_${side}` as keyof typeof settings;
            return (
              <div key={side}>
                <label className="block text-xs mb-1 capitalize" style={{ color: "var(--text-secondary)" }}>
                  {side} (px)
                </label>
                <input
                  type="number"
                  className="input w-full"
                  value={(settings[key] as number) ?? 0}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, [key]: parseInt(e.target.value, 10) || 0 }))
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !dealerId}
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
        {saveStatus === "saved" && (
          <span className="text-sm" style={{ color: "var(--success)" }}>Saved</span>
        )}
        {saveStatus === "error" && (
          <span className="text-sm" style={{ color: "var(--error)" }}>{error}</span>
        )}
      </div>
    </div>
  );
}
