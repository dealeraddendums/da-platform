"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DealerRow } from "@/lib/db";
import { PageHeader } from "@/components/PageHeader";
import type { LabelProduct } from "@/lib/label-products";
import { LABEL_PRODUCTS } from "@/lib/label-products";
import type { AddendumPaperSize } from "@/lib/recommended-labels";
import { paperSizeWidthLabel, productMatchesPaperSize } from "@/lib/recommended-labels";

type Tab = "info" | "shipping" | "labels" | "orders" | "billing" | "hubspot" | "security";

type Props = {
  dealer?: DealerRow | null;
  /** Edit access to InfoTab + ShippingTab (dealer_admin only). */
  canEdit: boolean;
  /** Place label orders (dealer_admin OR dealer_user). Distinct from
   *  `canEdit` so dealer_user can buy labels without gaining edit on the
   *  dealer profile / shipping address. */
  canOrderLabels: boolean;
  /** Paper sizes of the dealer's active addendum template assignments.
   *  Drives the "Recommended for your dealership" badge on matching
   *  label-size cards. Empty array → no recommendation shown. */
  recommendedPaperSizes: AddendumPaperSize[];
  userEmail: string;
  userName: string;
  userRole: string;
  memberSince: string;
};

// ── Dealership Info Tab ──────────────────────────────────────────────────────

function InfoTab({ dealer, canEdit }: { dealer: DealerRow; canEdit: boolean }) {
  const [form, setForm] = useState({
    name: dealer.name ?? "",
    primary_contact: dealer.primary_contact ?? "",
    primary_contact_email: dealer.primary_contact_email ?? "",
    phone: dealer.phone ?? "",
    address: dealer.address ?? "",
    city: dealer.city ?? "",
    state: dealer.state ?? "",
    zip: dealer.zip ?? "",
    country: dealer.country ?? "US",
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setSuccess(false);
    setError("");
    try {
      const res = await fetch(`/api/dealers/${dealer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  return (
    <div style={{ maxWidth: 560 }}>
      {dealer.logo_url && (
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Dealership Logo</label>
          <img
            src={dealer.logo_url}
            alt="Logo"
            style={{ maxHeight: 60, maxWidth: 200, objectFit: "contain", display: "block" }}
          />
        </div>
      )}

      <div style={rowStyle}>
        <Field label="Dealership Name" value={form.name} onChange={set("name")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Primary Contact" value={form.primary_contact} onChange={set("primary_contact")} disabled={!canEdit} />
        <Field label="Contact Email" value={form.primary_contact_email} onChange={set("primary_contact_email")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Phone" value={form.phone} onChange={set("phone")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Address" value={form.address} onChange={set("address")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="City" value={form.city} onChange={set("city")} disabled={!canEdit} />
        <Field label="State" value={form.state} onChange={set("state")} disabled={!canEdit} style={{ maxWidth: 80 }} />
        <Field label="Zip" value={form.zip} onChange={set("zip")} disabled={!canEdit} style={{ maxWidth: 100 }} />
      </div>

      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: "#78828c" }}>
          Internal ID: <strong>{dealer.internal_id ?? "—"}</strong>
        </span>
      </div>

      {canEdit && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
          {success && <span style={{ fontSize: 13, color: "#4caf50" }}>Saved</span>}
          {error && <span style={{ fontSize: 13, color: "#ff5252" }}>{error}</span>}
        </div>
      )}

    </div>
  );
}

// ── Passkey / Security Card ───────────────────────────────────────────────────

type PasskeyRow = {
  id: string;
  friendly_name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
};

function PasskeyCard() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addSuccess, setAddSuccess] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      !!window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    ) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(available => setSupported(available))
        .catch(() => {});
    }
    fetchPasskeys();
  }, []);

  async function fetchPasskeys() {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/passkey/list");
      if (res.ok) {
        const d = await res.json() as { passkeys: PasskeyRow[] };
        setPasskeys(d.passkeys ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    setAddError("");
    setAddSuccess(false);
    setAdding(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");

      const startRes = await fetch("/api/auth/passkey/register-start", { method: "POST" });
      if (!startRes.ok) {
        const d = await startRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Could not start passkey registration.");
      }
      const options = await startRes.json();

      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("cancelled") || msg.includes("NotAllowedError")) {
          throw new Error("Registration was cancelled.");
        }
        throw e;
      }

      const completeRes = await fetch("/api/auth/passkey/register-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Registration failed.");
      }

      setAddSuccess(true);
      await fetchPasskeys();
      setTimeout(() => setAddSuccess(false), 3000);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Registration failed.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
    setDeletingId(id);
    try {
      await fetch(`/api/auth/passkey/${id}`, { method: "DELETE" });
      await fetchPasskeys();
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    try {
      await fetch(`/api/auth/passkey/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendly_name: editName.trim() }),
      });
      setEditingId(null);
      await fetchPasskeys();
    } catch {
      // ignore
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div
      style={{
        marginTop: 32,
        paddingTop: 24,
        borderTop: "1px solid #e0e0e0",
        maxWidth: 560,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c", margin: "0 0 4px" }}>
          Passkeys
        </h3>
        <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
          Sign in faster with Face ID, Touch ID, or your device PIN instead of a password.
        </p>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "#78828c" }}>Loading…</div>
      ) : passkeys.length === 0 ? (
        <div
          style={{
            background: "#f5f6f7",
            border: "1px solid #e0e0e0",
            borderRadius: 4,
            padding: "12px 14px",
            fontSize: 13,
            color: "#78828c",
            marginBottom: 12,
          }}
        >
          No passkeys registered on this account.
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {passkeys.map(pk => (
            <div
              key={pk.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                border: "1px solid #e0e0e0",
                borderRadius: 4,
                background: "#fff",
                marginBottom: 6,
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === pk.id ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleRename(pk.id); if (e.key === "Escape") setEditingId(null); }}
                      autoFocus
                      style={{
                        height: 28, padding: "0 8px", border: "1px solid #1976d2",
                        borderRadius: 4, fontSize: 13, outline: "none", width: 160,
                      }}
                    />
                    <button onClick={() => handleRename(pk.id)} style={{ ...primaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ ...secondaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#2a2b3c" }}>{pk.friendly_name}</span>
                    {pk.device_type === "multiDevice" && pk.backed_up && (
                      <span style={{ fontSize: 11, background: "#e3f2fd", color: "#1565c0", border: "1px solid #bbdefb", borderRadius: 20, padding: "1px 6px", fontWeight: 600 }}>
                        Cloud
                      </span>
                    )}
                    <button
                      onClick={() => { setEditingId(pk.id); setEditName(pk.friendly_name); }}
                      style={{ background: "none", border: "none", color: "#78828c", cursor: "pointer", fontSize: 12, padding: "0 2px" }}
                    >
                      Rename
                    </button>
                  </div>
                )}
                <div style={{ fontSize: 11, color: "#78828c", marginTop: 2 }}>
                  Added {formatDate(pk.created_at)} · Last used {formatDate(pk.last_used_at)}
                </div>
              </div>
              <button
                onClick={() => handleDelete(pk.id)}
                disabled={deletingId === pk.id}
                style={{
                  background: "none",
                  border: "1px solid #ffcdd2",
                  borderRadius: 4,
                  color: "#c62828",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "4px 10px",
                  flexShrink: 0,
                  opacity: deletingId === pk.id ? 0.5 : 1,
                }}
              >
                {deletingId === pk.id ? "Removing…" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      {addError && (
        <div style={{ fontSize: 13, color: "#c62828", marginBottom: 10 }}>{addError}</div>
      )}
      {addSuccess && (
        <div style={{ fontSize: 13, color: "#2e7d32", marginBottom: 10 }}>Passkey added successfully.</div>
      )}

      {supported ? (
        <button onClick={handleAdd} disabled={adding} style={{ ...primaryBtn, opacity: adding ? 0.6 : 1 }}>
          {adding ? "Waiting for device…" : passkeys.length === 0 ? "+ Add Passkey" : "+ Add Another Passkey"}
        </button>
      ) : (
        <p style={{ fontSize: 12, color: "#78828c", margin: 0 }}>
          Passkeys require a device with Face ID, Touch ID, or a PIN. Not supported in this browser.
        </p>
      )}
    </div>
  );
}

// ── Account Info Card ────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  group_admin: "Group Admin",
  group_user: "Group User",
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
  dealer_restricted: "Dealer User",
};

function AccountInfoCard({
  userEmail,
  userRole,
  memberSince,
}: {
  userEmail: string;
  userRole: string;
  memberSince: string;
}) {
  const memberDate = new Date(memberSince).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "24px" }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "#2a2b3c", margin: "0 0 16px" }}>
        Account Info
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 2 }}>Email</div>
          <div style={{ fontSize: 14, color: "#2a2b3c" }}>{userEmail}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 4 }}>Role</div>
          <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#e3f2fd", color: "#1565c0" }}>
            {ROLE_LABELS[userRole] ?? userRole}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 2 }}>Member Since</div>
          <div style={{ fontSize: 14, color: "#2a2b3c" }}>{memberDate}</div>
        </div>
        <div style={{ paddingTop: 4 }}>
          <a
            href="/reset-password"
            style={{ display: "inline-block", fontSize: 13, color: "#1976d2", textDecoration: "none", fontWeight: 500 }}
          >
            Change Password →
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Security Tab ─────────────────────────────────────────────────────────────

// ── HubSpot Sync Tab (super_admin only, ghost mode required) ────────────────
//
// Thin UI over POST /api/hubspot/sync. The button kicks off the SSE stream;
// each event renders as a row with a spinner / ✓ / ✗ indicator. Behavior
// mirrors the existing event-driven sync — this just lets support trigger
// it on demand without waiting for an edit event.

interface HubSpotEvent {
  step: "start" | "company" | "contact" | "done";
  status?: "running" | "done" | "error";
  message?: string;
  email?: string;
  hubspotId?: string;
  name?: string | null;
  okCount?: number;
  errorCount?: number;
  userCount?: number;
}

function HubSpotSyncTab({ dealer }: { dealer: DealerRow }) {
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<HubSpotEvent[]>([]);
  const [summary, setSummary] = useState<{ ok: number; err: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setRunning(true);
    setEvents([]);
    setSummary(null);
    setError(null);
    try {
      const res = await fetch("/api/hubspot/sync", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Request failed (${res.status})`);
        setRunning(false);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        setError("Browser doesn't support streaming responses");
        setRunning(false);
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      // Read SSE frames (`data: {...}\n\n`) as they arrive.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const evt = JSON.parse(line.slice(5).trim()) as HubSpotEvent;
              setEvents(prev => mergeEvent(prev, evt));
              if (evt.step === "done") setSummary({ ok: evt.okCount ?? 0, err: evt.errorCount ?? 0 });
            } catch {
              // bad frame — ignore so the stream keeps going
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  // Latest event for a given step/key supersedes the prior one — so a
  // contact line goes from `running` → `done` in place rather than
  // showing two rows.
  function mergeEvent(prev: HubSpotEvent[], evt: HubSpotEvent): HubSpotEvent[] {
    const key = evt.step === "contact" ? `contact:${evt.email}` : evt.step;
    const idx = prev.findIndex(p => (p.step === "contact" ? `contact:${p.email}` : p.step) === key);
    if (idx === -1) return [...prev, evt];
    const copy = prev.slice();
    copy[idx] = evt;
    return copy;
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 4px 0", fontSize: 16, fontWeight: 600, color: "#2a2b3c" }}>Manual HubSpot Sync</h3>
        <p style={{ margin: 0, color: "#78828c", fontSize: 13 }}>
          Pushes <strong>{dealer.name ?? dealer.dealer_id}</strong> + every active user to HubSpot right now.
          Use this after a correction, or if an event-sync was missed. Computed totals
          (<code>prints_last_12mo</code>, <code>dealers_in_group</code>) refresh nightly.
        </p>
      </div>

      <button
        onClick={() => void start()}
        disabled={running}
        style={{
          padding: "8px 16px",
          background: running ? "#9aa4ad" : "#1976d2",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: running ? "default" : "pointer",
          fontSize: 14,
          fontFamily: "inherit",
        }}
      >
        {running ? "Syncing…" : "Start Sync"}
      </button>

      {error && (
        <div style={{ marginTop: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", border: "1px solid #ffcdd2", borderRadius: 4, fontSize: 13 }}>
          {error}
        </div>
      )}

      {events.length > 0 && (
        <ul style={{ marginTop: 16, padding: 0, listStyle: "none", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff" }}>
          {events.filter(e => e.step !== "start" && e.step !== "done").map((e, i) => {
            const ok = e.status === "done";
            const err = e.status === "error";
            const indicator = ok ? "✓" : err ? "✗" : "…";
            const indicatorColor = ok ? "#2e7d32" : err ? "#c62828" : "#78828c";
            const label = e.step === "company"
              ? "Company"
              : `Contact — ${e.email}`;
            return (
              <li key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", borderBottom: i < events.length - 1 ? "1px solid #f0f0f0" : "none", fontSize: 13 }}>
                <span style={{ width: 20, textAlign: "center", fontWeight: 700, color: indicatorColor }}>{indicator}</span>
                <span style={{ flex: 1, color: "#2a2b3c" }}>{label}</span>
                {e.hubspotId && (
                  <span style={{ color: "#78828c", fontFamily: "monospace", fontSize: 12 }}>id {e.hubspotId}</span>
                )}
                {err && e.message && (
                  <span style={{ color: "#c62828", fontSize: 12 }}>{e.message}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {summary && (
        <div style={{ marginTop: 12, fontSize: 13, color: summary.err > 0 ? "#c62828" : "#2e7d32" }}>
          {summary.err === 0
            ? `Done — ${summary.ok} record${summary.ok === 1 ? "" : "s"} synced.`
            : `${summary.ok} ok, ${summary.err} failed — check hubspot_sync_errors for details.`}
        </div>
      )}
    </div>
  );
}

function SecurityTab({
  userEmail,
  userRole,
  memberSince,
}: {
  userEmail: string;
  userRole: string;
  memberSince: string;
}) {
  return (
    <div style={{ maxWidth: 640 }}>
      <PasskeyCard />
      <div style={{ marginTop: 20 }}>
        <AccountInfoCard userEmail={userEmail} userRole={userRole} memberSince={memberSince} />
      </div>
    </div>
  );
}

// ── Shipping Address Tab ─────────────────────────────────────────────────────

function ShippingTab({ dealer, canEdit }: { dealer: DealerRow; canEdit: boolean }) {
  const [form, setForm] = useState({
    shipping_name: dealer.shipping_name ?? "",
    shipping_attention: dealer.shipping_attention ?? "",
    shipping_address: dealer.shipping_address ?? "",
    shipping_address2: dealer.shipping_address2 ?? "",
    shipping_city: dealer.shipping_city ?? "",
    shipping_state: dealer.shipping_state ?? "",
    shipping_zip: dealer.shipping_zip ?? "",
    shipping_country: dealer.shipping_country ?? "US",
    shipping_phone: dealer.shipping_phone ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  function copyFromInfo() {
    setForm({
      shipping_name: dealer.name ?? "",
      shipping_attention: dealer.primary_contact ?? "",
      shipping_address: dealer.address ?? "",
      shipping_address2: "",
      shipping_city: dealer.city ?? "",
      shipping_state: dealer.state ?? "",
      shipping_zip: dealer.zip ?? "",
      shipping_country: dealer.country ?? "US",
      shipping_phone: dealer.phone ?? "",
    });
  }

  async function handleSave() {
    setSaving(true);
    setSuccess(false);
    setError("");
    try {
      const res = await fetch(`/api/dealers/${dealer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ fontSize: 13, color: "#78828c", marginBottom: 16 }}>
        This address is used for label orders. If different from your dealership address,
        update it here.
      </p>

      {canEdit && (
        <button onClick={copyFromInfo} style={{ ...secondaryBtn, marginBottom: 20 }}>
          Copy from Dealership Info
        </button>
      )}

      <div style={rowStyle}>
        <Field label="Ship-to Name" value={form.shipping_name} onChange={set("shipping_name")} disabled={!canEdit} />
        <Field label="Attention" value={form.shipping_attention} onChange={set("shipping_attention")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Address" value={form.shipping_address} onChange={set("shipping_address")} disabled={!canEdit} />
        <Field label="Suite / Unit" value={form.shipping_address2} onChange={set("shipping_address2")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="City" value={form.shipping_city} onChange={set("shipping_city")} disabled={!canEdit} />
        <Field label="State" value={form.shipping_state} onChange={set("shipping_state")} disabled={!canEdit} style={{ maxWidth: 80 }} />
        <Field label="Zip" value={form.shipping_zip} onChange={set("shipping_zip")} disabled={!canEdit} style={{ maxWidth: 100 }} />
      </div>
      <div style={rowStyle}>
        <Field label="Phone" value={form.shipping_phone} onChange={set("shipping_phone")} disabled={!canEdit} />
        <Field label="Country" value={form.shipping_country} onChange={set("shipping_country")} disabled={!canEdit} style={{ maxWidth: 80 }} />
      </div>

      {canEdit && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? "Saving…" : "Save Shipping Address"}
          </button>
          {success && <span style={{ fontSize: 13, color: "#4caf50" }}>Saved</span>}
          {error && <span style={{ fontSize: 13, color: "#ff5252" }}>{error}</span>}
        </div>
      )}
    </div>
  );
}

// ── Order Labels Tab ─────────────────────────────────────────────────────────

type CartItem = {
  product: LabelProduct;
  optionIdx: number;
};

function OrderLabelsTab({
  dealer,
  canOrder,
  recommendedPaperSizes,
  userEmail,
  userName,
}: {
  dealer: DealerRow;
  /** Allowed to place a label order. dealer_admin OR dealer_user. */
  canOrder: boolean;
  recommendedPaperSizes: AddendumPaperSize[];
  userEmail: string;
  userName: string;
}) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [shipOverride, setShipOverride] = useState(false);
  const [shipForm, setShipForm] = useState({
    name: dealer.shipping_name || dealer.name || "",
    attention: dealer.shipping_attention || "",
    address1: dealer.shipping_address || dealer.address || "",
    address2: dealer.shipping_address2 || "",
    city: dealer.shipping_city || dealer.city || "",
    state: dealer.shipping_state || dealer.state || "",
    zip: dealer.shipping_zip || dealer.zip || "",
    country: dealer.shipping_country || dealer.country || "US",
    phone: dealer.shipping_phone || dealer.phone || "",
  });
  const [placing, setPlacing] = useState(false);
  const [orderResult, setOrderResult] = useState<{
    success: boolean;
    orderId?: string;
    message: string;
  } | null>(null);

  // One-time free trial label sample (Trial dealers only). See /api/trial-labels.
  const [trialLabelStep, setTrialLabelStep] = useState<'idle' | 'form' | 'placing' | 'done'>('idle');
  const [trialLabelSku, setTrialLabelSku] = useState('8300-1');
  const [trialLabelShipTo, setTrialLabelShipTo] = useState({
    name: dealer.primary_contact ?? '',
    company: dealer.name ?? '',
    address1: '',
    city: '',
    state: '',
    zip: '',
    country: 'US',
    phone: '',
  });
  const [trialLabelResult, setTrialLabelResult] = useState<string | null>(null);

  async function placeTrialLabels() {
    setTrialLabelResult(null);
    if (!trialLabelShipTo.name || !trialLabelShipTo.address1 || !trialLabelShipTo.city || !trialLabelShipTo.state || !trialLabelShipTo.zip) {
      setTrialLabelResult('Please fill in name, address, city, state, and ZIP.');
      return;
    }
    setTrialLabelStep('placing');
    try {
      const res = await fetch('/api/trial-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealerUuid: dealer.id, labelSku: trialLabelSku, shipTo: trialLabelShipTo }),
      });
      const json = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.ok && (json as { success?: boolean }).success) {
        setTrialLabelStep('done');
      } else if (res.status === 409 || (json as { error?: string }).error === 'already_claimed') {
        setTrialLabelStep('done'); // already claimed elsewhere — show the done state
      } else {
        setTrialLabelStep('form');
        const err = (json as { error?: string }).error;
        setTrialLabelResult(err ? `Could not place order: ${err}` : 'Could not place order. Please try again or contact support.');
      }
    } catch {
      setTrialLabelStep('form');
      setTrialLabelResult('Network error — please try again.');
    }
  }

  // Clear any stale orderResult from a previous interaction. Initial
  // useState(null) is enough on a hard navigation, but soft navigation
  // within /profile (e.g. tab switching back to labels after seeing an
  // error) keeps OrderLabelsTab's parent component mounted and state
  // alive. This effect resets the result every time the labels tab
  // re-mounts so the old error/success card doesn't reappear.
  useEffect(() => {
    setOrderResult(null);
  }, []);

  const setShip = (k: keyof typeof shipForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setShipForm(prev => ({ ...prev, [k]: e.target.value }));
      // Any change to the order parameters dismisses the previous result.
      setOrderResult(null);
    };

  function toggleOption(product: LabelProduct, optionIdx: number) {
    // Clear the previous result the moment the user starts a new order.
    setOrderResult(null);
    setCart(prev => {
      const existing = prev.find(c => c.product.sku === product.sku);
      if (existing) {
        if (existing.optionIdx === optionIdx) {
          return prev.filter(c => c.product.sku !== product.sku);
        }
        return prev.map(c => c.product.sku === product.sku ? { ...c, optionIdx } : c);
      }
      return [...prev, { product, optionIdx }];
    });
  }

  function isSelected(sku: string, idx: number) {
    return cart.some(c => c.product.sku === sku && c.optionIdx === idx);
  }

  const cartTotal = cart.reduce((s, c) => s + c.product.options[c.optionIdx].price, 0);

  async function placeOrder() {
    if (cart.length === 0) return;
    setPlacing(true);
    setOrderResult(null);

    const items = cart.map(c => ({
      sku: c.product.sku,
      qty: c.product.options[c.optionIdx].qty,
      price: c.product.options[c.optionIdx].price,
      shipping: c.product.options[c.optionIdx].shipping,
      productName: c.product.name,
    }));

    const shipTo = {
      name: shipForm.name,
      attention: shipForm.attention || undefined,
      address1: shipForm.address1,
      address2: shipForm.address2 || undefined,
      city: shipForm.city,
      state: shipForm.state,
      zip: shipForm.zip,
      country: shipForm.country || "US",
      phone: shipForm.phone || undefined,
    };

    try {
      const res = await fetch("/api/orders/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          shipTo,
          dealerId: dealer.id,
          dealerName: dealer.name,
          internalDealerId: dealer.internal_id ?? dealer.dealer_id,
          orderedByName: userName,
          orderedByEmail: userEmail,
        }),
      });
      // 2xx responses carry { success, orderId?, message }; non-2xx
      // carry { error } per the route's reject paths (e.g. Free/Trial
      // 403, validation 400). Normalize both shapes into the
      // success+message structure orderResult expects so the red box
      // doesn't render with just the ✕ icon and no text.
      const data = await res.json().catch(() => ({})) as Partial<{
        success: boolean;
        orderId: string;
        message: string;
        error: string;
      }>;
      if (res.ok) {
        setOrderResult({
          success: data.success ?? true,
          orderId: data.orderId,
          message: data.message ?? "Order placed.",
        });
        if (data.success) setCart([]);
      } else {
        setOrderResult({
          success: false,
          message: data.error ?? data.message ?? `Order failed (${res.status})`,
        });
      }
    } catch {
      setOrderResult({ success: false, message: "Network error — please try again." });
    } finally {
      setPlacing(false);
    }
  }

  // Free / Trial dealers without a group can't place orders — the
  // server would 403 them via the Case 4 reject. Block the UI before
  // they try so they get a clear path forward rather than a generic
  // error in the order result box.
  const accountType = dealer.account_type ?? null;
  const isFreeOrTrial =
    !accountType
    || accountType === "Free"
    || accountType === "Trial";
  const noSubscriptionAccess = isFreeOrTrial && !dealer.group_id;

  return (
    <div>
      {noSubscriptionAccess && (
        <>
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #ffa500",
            borderRadius: 6,
            padding: "14px 18px",
            marginBottom: 20,
            fontSize: 14,
            color: "#5a4500",
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: "#7a5c00" }}>
            Label orders require an active subscription
          </div>
          Please contact DealerAddendums at{" "}
          <a href="mailto:support@dealeraddendums.com" style={{ color: "#1976d2", textDecoration: "none" }}>
            support@dealeraddendums.com
          </a>{" "}
          or call{" "}
          <a href="tel:+18014159435" style={{ color: "#1976d2", textDecoration: "none" }}>
            801-415-9435
          </a>{" "}
          to upgrade your account.
        </div>

        {accountType === "Trial" && (
          <div
            style={{
              background: "#fff",
              border: "1px solid #e0e0e0",
              borderRadius: 6,
              padding: "18px 20px",
              marginBottom: 20,
              fontFamily: "Roboto, sans-serif",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: "#2a2b3c", marginBottom: 6 }}>
              🏷 Try before you buy — get 25 free labels
            </div>
            <div style={{ fontSize: 14, color: "#55595c", lineHeight: 1.6, marginBottom: 14 }}>
              We&apos;ll send you a free sample pack so you can test our labels before subscribing.
            </div>

            {(dealer.trial_labels_claimed_at || trialLabelStep === "done") ? (
              <div style={{ fontSize: 14, color: "#15803D", fontWeight: 600 }}>
                ✓{" "}
                {trialLabelStep === "done" && !dealer.trial_labels_claimed_at
                  ? "Your free sample is on its way!"
                  : `Free sample requested${
                      dealer.trial_labels_claimed_at
                        ? " on " +
                          new Date(dealer.trial_labels_claimed_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : ""
                    }.`}
              </div>
            ) : trialLabelStep === "placing" ? (
              <div style={{ fontSize: 14, color: "#55595c" }}>Placing order…</div>
            ) : trialLabelStep === "form" ? (
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4 }}>
                  Label type
                </label>
                <select
                  value={trialLabelSku}
                  onChange={e => setTrialLabelSku(e.target.value)}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 14, marginBottom: 12, fontFamily: "inherit", boxSizing: "border-box" }}
                >
                  <option value="8300-1">Regular Addendums (4.25&quot;×11&quot;)</option>
                  <option value="8300-3">Narrow Addendums (3.125&quot;×11&quot;)</option>
                  <option value="8300">Full Sheet Labels (8.5&quot;×11&quot;)</option>
                </select>
                {([
                  ["name", "Name *"],
                  ["company", "Company"],
                  ["address1", "Address *"],
                  ["city", "City *"],
                  ["state", "State *"],
                  ["zip", "ZIP *"],
                  ["phone", "Phone"],
                ] as [keyof typeof trialLabelShipTo, string][]).map(([k, lbl]) => (
                  <input
                    key={k}
                    placeholder={lbl}
                    value={trialLabelShipTo[k]}
                    onChange={e => setTrialLabelShipTo(prev => ({ ...prev, [k]: e.target.value }))}
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 14, marginBottom: 8, boxSizing: "border-box", fontFamily: "inherit" }}
                  />
                ))}
                {trialLabelResult && (
                  <div style={{ fontSize: 13, color: "#c62828", marginBottom: 8 }}>{trialLabelResult}</div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button
                    onClick={placeTrialLabels}
                    style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, padding: "9px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Request Free Labels
                  </button>
                  <button
                    onClick={() => { setTrialLabelStep("idle"); setTrialLabelResult(null); }}
                    style={{ background: "#fff", color: "#55595c", border: "1px solid #e0e0e0", borderRadius: 4, padding: "9px 16px", fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setTrialLabelStep("form")}
                style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
              >
                Get Free Labels →
              </button>
            )}
          </div>
        )}
        </>
      )}

      {!canOrder && !noSubscriptionAccess && (
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #ffa500",
            borderRadius: 4,
            padding: "10px 14px",
            marginBottom: 20,
            fontSize: 13,
            color: "#555",
          }}
        >
          Label orders aren&apos;t available for your role. Contact your dealer administrator to place an order.
        </div>
      )}

      {/* Product grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
          marginBottom: 28,
        }}
      >
        {LABEL_PRODUCTS.map(product => {
          const selectedItem = cart.find(c => c.product.sku === product.sku);
          const isRecommended = recommendedPaperSizes.some(ps =>
            productMatchesPaperSize(product.size, ps),
          );
          return (
            <div
              key={product.sku}
              style={{
                background: "#fff",
                // Recommended cards get the orange accent border from the DA
                // design system; selected (cart) state still wins so the
                // dealer can see what they've actually picked.
                border: selectedItem
                  ? "2px solid #1976d2"
                  : isRecommended
                    ? "2px solid #ffa500"
                    : "1px solid #e0e0e0",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "12px 14px 8px",
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 2 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "#2a2b3c" }}>
                    {product.name}
                  </div>
                  {isRecommended && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "2px 7px",
                        borderRadius: 10,
                        background: "#ffa500",
                        color: "#fff",
                        textTransform: "uppercase",
                        letterSpacing: ".04em",
                        whiteSpace: "nowrap",
                      }}
                      title="Recommended for your dealership"
                    >
                      Recommended
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#78828c" }}>{product.size}</div>
              </div>
              <div style={{ padding: "8px 14px 12px" }}>
                {product.options.map((opt, idx) => {
                  const sel = isSelected(product.sku, idx);
                  return (
                    <button
                      key={idx}
                      onClick={() => canOrder && toggleOption(product, idx)}
                      disabled={!canOrder}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "6px 8px",
                        marginBottom: 4,
                        borderRadius: 4,
                        border: sel ? "1px solid #1976d2" : "1px solid #e0e0e0",
                        background: sel ? "#e3f2fd" : "#fafafa",
                        cursor: canOrder ? "pointer" : "default",
                        fontSize: 13,
                        color: "#333",
                        textAlign: "left",
                      }}
                    >
                      <span>
                        {opt.qty.toLocaleString()} labels
                        {opt.shipping === "fedex" && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              background: "#fff3e0",
                              color: "#e65100",
                              border: "1px solid #ffcc02",
                              borderRadius: 3,
                              padding: "1px 4px",
                              fontWeight: 600,
                            }}
                          >
                            FedEx
                          </span>
                        )}
                      </span>
                      <span style={{ fontWeight: 600, color: "#1976d2", fontFamily: "monospace" }}>
                        ${opt.price.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {recommendedPaperSizes.length > 0 && (() => {
        const recommendedProducts = LABEL_PRODUCTS.filter(p =>
          recommendedPaperSizes.some(ps => productMatchesPaperSize(p.size, ps)),
        );
        const widths = recommendedPaperSizes.map(paperSizeWidthLabel);
        // Comma-then-and join — "A, B and C" feels less terse than commas alone.
        const widthSentence = widths.length === 1
          ? widths[0]
          : widths.length === 2
            ? `${widths[0]} and ${widths[1]}`
            : `${widths.slice(0, -1).join(", ")} and ${widths[widths.length - 1]}`;
        const names = recommendedProducts.map(p => p.name);
        const nameSentence = names.length === 1
          ? names[0]
          : names.length === 2
            ? `${names[0]} or ${names[1]}`
            : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
        return (
          <div
            style={{
              marginTop: -12,
              marginBottom: 24,
              padding: "10px 14px",
              background: "#fff8e1",
              border: "1px solid #ffe082",
              borderRadius: 6,
              fontSize: 13,
              color: "#7a5c00",
            }}
          >
            Your active addendum template{recommendedPaperSizes.length > 1 ? "s use" : " uses"}{" "}
            <strong>{widthSentence}</strong> labels — we recommend <strong>{nameSentence}</strong>.
          </div>
        );
      })()}

      {/* Ship-to block */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: "16px 20px",
          marginBottom: 20,
          maxWidth: 560,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c", margin: 0 }}>
            Ship To
          </h3>
          {canOrder && (
            <button
              onClick={() => setShipOverride(v => !v)}
              style={{ ...secondaryBtn, fontSize: 12, padding: "4px 10px", height: "auto" }}
            >
              {shipOverride ? "Use saved address" : "Edit address"}
            </button>
          )}
        </div>

        {!shipOverride ? (
          <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.8 }}>
            {shipForm.attention && <div>Attn: {shipForm.attention}</div>}
            <div>{shipForm.name}</div>
            <div>{shipForm.address1}{shipForm.address2 ? `, ${shipForm.address2}` : ""}</div>
            <div>{shipForm.city}, {shipForm.state} {shipForm.zip}</div>
            <div>{shipForm.country}</div>
            {shipForm.phone && <div>{shipForm.phone}</div>}
            {!shipForm.address1 && (
              <div style={{ color: "#ff5252", fontSize: 12 }}>
                No shipping address on file. Click &quot;Edit address&quot; to add one.
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={rowStyle}>
              <Field label="Name" value={shipForm.name} onChange={setShip("name")} />
              <Field label="Attention" value={shipForm.attention} onChange={setShip("attention")} />
            </div>
            <div style={rowStyle}>
              <Field label="Address" value={shipForm.address1} onChange={setShip("address1")} />
              <Field label="Suite / Unit" value={shipForm.address2} onChange={setShip("address2")} />
            </div>
            <div style={rowStyle}>
              <Field label="City" value={shipForm.city} onChange={setShip("city")} />
              <Field label="State" value={shipForm.state} onChange={setShip("state")} style={{ maxWidth: 80 }} />
              <Field label="Zip" value={shipForm.zip} onChange={setShip("zip")} style={{ maxWidth: 100 }} />
            </div>
            <div style={rowStyle}>
              <Field label="Phone" value={shipForm.phone} onChange={setShip("phone")} />
              <Field label="Country" value={shipForm.country} onChange={setShip("country")} style={{ maxWidth: 80 }} />
            </div>
          </div>
        )}
      </div>

      {/* Order summary + place order — hidden for Free/Trial dealers
          without a group so they can't submit an order that the server
          would 403. */}
      {canOrder && !noSubscriptionAccess && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            padding: "16px 20px",
            maxWidth: 560,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c", marginBottom: 12, margin: "0 0 12px" }}>
            Order Summary
          </h3>
          {cart.length === 0 ? (
            <p style={{ fontSize: 13, color: "#78828c" }}>
              Select label options above to build your order.
            </p>
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
                <thead>
                  <tr style={{ background: "#f5f6f7" }}>
                    <th style={thStyle}>Product</th>
                    <th style={thStyle}>Qty</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map(c => (
                    <tr key={c.product.sku} style={{ borderBottom: "1px solid #e0e0e0" }}>
                      <td style={tdStyle}>
                        {c.product.name}
                        {c.product.options[c.optionIdx].shipping === "fedex" && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              background: "#fff3e0",
                              color: "#e65100",
                              border: "1px solid #ffcc02",
                              borderRadius: 3,
                              padding: "1px 4px",
                              fontWeight: 600,
                            }}
                          >
                            FedEx
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{c.product.options[c.optionIdx].qty.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: "#1976d2" }}>
                        ${c.product.options[c.optionIdx].price.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: "#f5f6f7", fontWeight: 700 }}>
                    <td colSpan={2} style={{ ...tdStyle, textAlign: "right" }}>Total</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace" }}>
                      ${cartTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tbody>
              </table>

              <button
                onClick={placeOrder}
                disabled={placing || cart.length === 0 || !shipForm.address1}
                style={{ ...primaryBtn, opacity: (placing || !shipForm.address1) ? 0.6 : 1 }}
              >
                {placing ? "Placing order…" : "Place Order"}
              </button>

              {!shipForm.address1 && (
                <div style={{ fontSize: 12, color: "#ff5252", marginTop: 8 }}>
                  A shipping address is required before placing an order.
                </div>
              )}
            </>
          )}

          {orderResult && (
            <div
              style={{
                marginTop: 16,
                padding: "12px 14px",
                borderRadius: 4,
                border: `1px solid ${orderResult.success ? "#4caf50" : "#ff5252"}`,
                background: orderResult.success ? "#e8f5e9" : "#ffebee",
                fontSize: 13,
                color: orderResult.success ? "#2e7d32" : "#c62828",
              }}
            >
              {orderResult.success ? "✓ " : "✕ "}
              {orderResult.message}
              {orderResult.orderId && (
                <div style={{ fontSize: 11, marginTop: 4, color: "#78828c" }}>
                  Order ID: {orderResult.orderId}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Orders Tab (label order history) ─────────────────────────────────────────

interface LabelOrderRow {
  id: string;
  items: Array<{ sku: string; qty: number; price: number; shipping: string; productName: string }>;
  ship_to: { city?: string; state?: string };
  total_amount: number | null;
  billed_to: "dealer" | "group" | null;
  billing_status: string | null;
  email_status: string | null;
  xps_status: string | null;
  xps_order_id: string | null;
  xps_tracking_number: string | null;
  xps_carrier: string | null;
  created_at: string;
  ordered_by?: string | null;
  ordered_by_name?: string | null;
}

// Carrier-specific tracking URL. XPS posts back a carrier code like
// "USPS" / "UPS" / "FEDEX" alongside the tracking number; we prefer the
// carrier's own tracking page when we know it and fall back to a generic
// search when we don't.
function trackingUrl(trackingNumber: string, carrier: string | null): string {
  const c = (carrier ?? "").toUpperCase();
  if (c.includes("USPS")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("UPS"))  return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("FEDEX")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("DHL"))  return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(trackingNumber)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trackingNumber)}+tracking`;
}

function StatusPill({ label, ok, warn }: { label: string; ok?: boolean; warn?: boolean }) {
  const bg = ok ? "#e8f5e9" : warn ? "#fff8e1" : "#ffebee";
  const color = ok ? "#2e7d32" : warn ? "#7a5c00" : "#c62828";
  const border = ok ? "#c8e6c9" : warn ? "#ffe082" : "#ffcdd2";
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: bg, color, border: `1px solid ${border}`, textTransform: "uppercase", letterSpacing: ".04em" }}>
      {label}
    </span>
  );
}

function OrdersTab() {
  const [orders, setOrders] = useState<LabelOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/orders/labels");
        if (!res.ok) {
          if (!cancelled) {
            setError("Failed to load order history");
            setLoading(false);
          }
          return;
        }
        const j = (await res.json()) as { data: LabelOrderRow[] };
        if (!cancelled) {
          setOrders(j.data ?? []);
          setLoading(false);
        }
      } catch {
        if (!cancelled) { setError("Failed to load order history"); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: "#2a2b3c", marginBottom: 4 }}>Label Order History</div>
        <p style={{ fontSize: 12, color: "#78828c", margin: 0 }}>
          Recent label orders and shipment tracking. Order Labels in the tab above to create a new order.
        </p>
      </div>
      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#78828c", fontSize: 13 }}>Loading…</div>
      ) : error ? (
        <div style={{ padding: 12, background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>
      ) : orders.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "#78828c", fontSize: 13, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fafafa" }}>
          No label orders yet.
        </div>
      ) : (
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead style={{ background: "#fafafa", borderBottom: "1px solid #e0e0e0" }}>
              <tr>
                {/* Billing status and "Billed to" routing are intentionally
                    omitted — both are DA-internal concerns, not something
                    the dealer needs to see on their own order history.
                    Dealers only need shipment status + tracking. */}
                {["Date", "Ordered By", "Items", "Total", "Status", "Tracking"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "10px 12px", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".04em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => {
                const itemSummary = o.items
                  .map(it => `${it.productName} × ${it.qty.toLocaleString()}`)
                  .join(", ");
                const shipped = o.xps_status === "shipped" || o.xps_status === "delivered";
                // Friendly shipment-state label. XPS gives us pending →
                // created → shipped → delivered; we collapse the first two
                // to a single "Pending shipment" message that matches the
                // wording in the order-confirmation email.
                const shipLabel = shipped
                  ? (o.xps_status === "delivered" ? "Delivered" : "Shipped")
                  : "Pending shipment";
                return (
                  <tr key={o.id} style={{ borderBottom: i < orders.length - 1 ? "1px solid #f0f0f0" : "none" }}>
                    <td style={{ padding: "10px 12px", color: "#555", whiteSpace: "nowrap" }}>
                      {new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </td>
                    <td style={{ padding: "10px 12px", color: "#333", whiteSpace: "nowrap" }}>
                      {o.ordered_by_name ?? "—"}
                    </td>
                    <td style={{ padding: "10px 12px", color: "#333", maxWidth: 320 }}>{itemSummary}</td>
                    <td style={{ padding: "10px 12px", color: "#333", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                      {o.total_amount != null ? `$${Number(o.total_amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <StatusPill
                        label={shipLabel}
                        ok={shipped}
                        warn={!shipped}
                      />
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {o.xps_tracking_number ? (
                        <a
                          href={trackingUrl(o.xps_tracking_number, o.xps_carrier)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "#1976d2", fontFamily: "monospace", fontSize: 12 }}
                        >
                          {o.xps_tracking_number}
                        </a>
                      ) : (
                        <span style={{ color: "#bbb", fontSize: 12 }}>—</span>
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
}

// ── Billing Tab (subscription + invoices) ────────────────────────────────────

interface BillingMeData {
  dealer: { id: string; name: string; billing_customer_id: string | null; internal_id: string | null };
  subscription: { productId: string | null; name: string | null; price: number | null; nextInvoiceDate: string | null } | null;
  pricing: Array<{ name: string; price: number }>;
  invoices: Array<{
    id: string;
    invoiceNumber?: string | number;
    date: string;
    dueDate?: string;
    total: number;
    status: string;
    paymentUrl?: string;
  }>;
  outstandingAmount: number;
  trial: { dayN: number; printN: number; overAllowance: boolean; daysCap: number; printsCap: number };
  billedBy?: "self" | "group";
  groupName?: string | null;
  subscriptionTier?: string | null;
  canManage?: boolean;
  groupPastDue?: boolean;
  notes?: string;
}

const SUBSCRIPTION_TIERS: Array<{ key: string; productKey: string; name: string; description: string }> = [
  { key: "manual",    productKey: "sub-manual",   name: "Monthly Subscription Manual",        description: "Manual data entry — addendums created one at a time" },
  { key: "auto-web",  productKey: "sub-auto-web", name: "Monthly Subscription Automatic Web", description: "Automatic ingest from your website inventory feed" },
  { key: "auto-dms",  productKey: "sub-auto-dms", name: "Monthly Subscription Automatic DMS", description: "Direct DMS integration — fastest sync" },
];

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function BillingTab({ openChangePlan = false }: { openChangePlan?: boolean }) {
  const [data, setData] = useState<BillingMeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Expanded on load when deep-linked via ?upgrade=1 (sidebar "Upgrade Now").
  // BillingTab only mounts client-side once the tab switches to "billing", so
  // seeding useState from the prop is hydration-safe.
  const [changeOpen, setChangeOpen] = useState(openChangePlan);
  const [savingTier, setSavingTier] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Close-flow state: which step of the close path the dealer is on.
  // null = picker visible, 'reason' = entering soft reason, 'closing' = POST in flight.
  const [closeStep, setCloseStep] = useState<null | "reason" | "closing">(null);
  const [closeReason, setCloseReason] = useState<string>("");
  const [closeDetail, setCloseDetail] = useState<string>("");

  const refresh = useCallbackFetch(setData, setLoading, setError);
  useEffect(() => { void refresh(); }, [refresh]);

  async function closeAccount() {
    setCloseStep("closing");
    setToast(null);
    try {
      const res = await fetch("/api/billing/me/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: closeReason || undefined, detail: closeDetail || undefined }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; message?: string; outstandingAmount?: number };
      if (!res.ok) {
        setToast(j.message ?? j.error ?? "Account close failed");
        setCloseStep("reason");
        return;
      }
      setToast("✓ Account closed. Billing stopped — you have 60 days to re-subscribe before the account is archived.");
      setCloseStep(null);
      setChangeOpen(false);
      await refresh();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Account close failed");
      setCloseStep("reason");
    }
  }

  async function changeTier(tier: { key: string; productKey: string; name: string }) {
    setSavingTier(tier.key);
    setToast(null);
    try {
      const res = await fetch("/api/billing/me/subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Send the productKey ("sub-auto-web"), not the short key ("auto-web") —
        // subscriptionDescriptorFor keys off the product slug / full name.
        body: JSON.stringify({ tier: tier.productKey }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        setToast(j.error ?? "Plan change failed");
        return;
      }
      setToast(`✓ Plan updated to ${tier.name}. Takes effect on the next invoice.`);
      setChangeOpen(false);
      await refresh();
    } finally {
      setSavingTier(null);
    }
  }

  if (loading) {
    return <div style={{ padding: 24, textAlign: "center", color: "#78828c", fontSize: 13 }}>Loading…</div>;
  }
  if (error || !data) {
    return <div style={{ padding: 12, background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error ?? "Failed to load billing"}</div>;
  }

  // ── Group-billed dealer: read-only summary (plan + payer), no manage UI ────
  // The subscription + invoices live on the group's da-billing customer — this
  // dealer can't see or pay them. Show what plan they have + who pays; hide
  // Change Plan, invoices, Pay, and the no-subscription/no-invoice empty states.
  if (data.billedBy === "group") {
    const groupName = data.groupName ?? "your dealer group";
    const tier = data.subscriptionTier ?? "Subscription";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {data.groupPastDue && (
          <div style={{ padding: "10px 14px", background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 6, fontSize: 13 }}>
            Your group has a past-due balance — printing is paused. Contact your group administrator.
          </div>
        )}
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 24, background: "#fff" }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: "#2a2b3c", marginBottom: 8 }}>
            Subscription: {tier}
          </div>
          <p style={{ fontSize: 14, color: "#555", lineHeight: 1.6, margin: 0 }}>
            Billed by your group: <strong>{groupName}</strong>. Contact your group administrator for billing changes.
          </p>
        </div>
      </div>
    );
  }

  const sub = data.subscription;
  const outstandingInvoices = data.invoices.filter((inv) => inv.status === "pending" || inv.status === "overdue");
  const paidInvoices = data.invoices.filter((inv) => inv.status === "paid");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {data.notes && (
        <div style={{ padding: "10px 14px", background: "#fff8e1", border: "1px solid #ffe082", color: "#7a5c00", borderRadius: 6, fontSize: 13 }}>
          {data.notes}
        </div>
      )}

      {toast && (
        <div style={{ padding: "10px 14px", background: toast.startsWith("✓") ? "#e8f5e9" : "#ffebee", border: `1px solid ${toast.startsWith("✓") ? "#c8e6c9" : "#ffcdd2"}`, color: toast.startsWith("✓") ? "#2e7d32" : "#c62828", borderRadius: 6, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* ── Current Subscription ─────────────────────────────────────────── */}
      <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 20, background: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#2a2b3c" }}>Current Subscription</div>
          <button
            onClick={() => setChangeOpen((v) => !v)}
            style={{ padding: "6px 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >
            {changeOpen ? "Cancel" : "Change Plan"}
          </button>
        </div>
        {sub ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, fontSize: 13 }}>
            <div>
              <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Plan</div>
              <div style={{ color: "#333" }}>
                {/* da-billing's template stores products by productId only (no
                    display name field), so sub.name is usually null. Map the
                    productId back to the human label from SUBSCRIPTION_TIERS. */}
                {sub.name ?? SUBSCRIPTION_TIERS.find(t => t.productKey === sub.productId)?.name ?? "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Price</div>
              <div style={{ color: "#333", fontFamily: "monospace" }}>{money(sub.price)}/month</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Next Invoice</div>
              <div style={{ color: "#333" }}>{sub.nextInvoiceDate ? new Date(sub.nextInvoiceDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#78828c" }}>No active subscription template.</div>
        )}

        {changeOpen && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f0f0f0" }}>
            <div style={{ fontSize: 12, color: "#78828c", marginBottom: 10 }}>
              Choose a new plan. The change takes effect on your next invoice — no proration for the current period.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SUBSCRIPTION_TIERS.map((tier) => {
                const priceEntry = data.pricing.find((p) => p.name.toLowerCase() === tier.productKey.toLowerCase());
                const tierPrice = priceEntry?.price ?? null;
                const isCurrent = sub?.productId === tier.productKey;
                const isSaving = savingTier === tier.key;
                return (
                  <button
                    key={tier.key}
                    disabled={isCurrent || isSaving}
                    onClick={() => void changeTier(tier)}
                    style={{
                      textAlign: "left",
                      padding: "10px 14px",
                      border: `1px solid ${isCurrent ? "#1976d2" : "#e0e0e0"}`,
                      background: isCurrent ? "#e3f2fd" : "#fff",
                      borderRadius: 6,
                      cursor: isCurrent ? "default" : isSaving ? "wait" : "pointer",
                      fontFamily: "inherit",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#333" }}>
                        {tier.name}
                        {isCurrent && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#1565c0" }}>CURRENT</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#78828c", marginTop: 2 }}>{tier.description}</div>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 13, color: "#333", whiteSpace: "nowrap" }}>
                      {money(tierPrice)}/mo
                    </div>
                  </button>
                );
              })}
              {/* ── Free / close-account option ──────────────────────────────
                  Per spec: rendered as a real choice in the picker so the
                  consequence is visible before the dealer commits. Selecting
                  does NOT call changeTier (that PATCHes to a paid plan);
                  it launches the close flow — balance pre-check then a
                  soft-reason modal. */}
              {(() => {
                const isCurrentFree = !sub || sub.productId == null;
                const balanceDue = data.outstandingAmount > 0;
                return (
                  <button
                    key="free"
                    disabled={isCurrentFree || closeStep !== null}
                    onClick={() => {
                      if (balanceDue) {
                        setToast(`Settle your balance (${money(data.outstandingAmount)}) before closing — see Outstanding Invoices below.`);
                        return;
                      }
                      setCloseReason("");
                      setCloseDetail("");
                      setCloseStep("reason");
                    }}
                    style={{
                      textAlign: "left",
                      padding: "10px 14px",
                      border: `1px solid ${isCurrentFree ? "#1976d2" : "#e0e0e0"}`,
                      background: isCurrentFree ? "#e3f2fd" : "#fff",
                      borderRadius: 6,
                      cursor: isCurrentFree || closeStep !== null ? "default" : "pointer",
                      fontFamily: "inherit",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#333" }}>
                        {isCurrentFree ? "Trial" : "Free"}
                        {isCurrentFree && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#1565c0" }}>CURRENT</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#78828c", marginTop: 2, lineHeight: 1.5 }}>
                        {isCurrentFree
                          ? (data.trial.overAllowance
                              ? `Trial ended — you've reached the ${data.trial.daysCap}-day or ${data.trial.printsCap}-print limit. Upgrade to keep printing.`
                              : `Trial — you're on day ${data.trial.dayN} of ${data.trial.daysCap} and have printed ${data.trial.printN} of ${data.trial.printsCap}. When you reach either limit, you'll need to upgrade to keep printing.`)
                          : "Cancels your subscription and closes your account. Billing stops immediately. You keep log-in access for 60 days (view only — no printing), then the account is archived. Re-subscribe any time within 60 days to restore it. Requires a $0 balance."}
                      </div>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 13, color: "#333", whiteSpace: "nowrap" }}>
                      $0/mo
                    </div>
                  </button>
                );
              })()}
            </div>
          </div>
        )}

        {/* ── Close-confirm modal (soft reason + final confirm) ──────────── */}
        {closeStep !== null && (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}
            onClick={e => { if (e.target === e.currentTarget && closeStep !== "closing") setCloseStep(null); }}
          >
            <div style={{ background: "#fff", borderRadius: 6, width: 460, maxWidth: "94vw", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
              <div style={{ padding: "14px 18px", background: "#2a2b3c", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Close account</span>
                {closeStep !== "closing" && (
                  <button onClick={() => setCloseStep(null)} style={{ fontSize: 20, color: "rgba(255,255,255,0.7)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}>×</button>
                )}
              </div>
              <div style={{ padding: 20 }}>
                <p style={{ fontSize: 13, color: "#333", margin: "0 0 14px", lineHeight: 1.5 }}>
                  Closing will cancel your subscription immediately. You&apos;ll keep log-in access for <strong>60 days</strong> (view only — no printing). Re-subscribe within 60 days to restore the account; after that it&apos;s archived.
                </p>

                <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>
                  Why are you leaving? <span style={{ color: "#9aa4ad", fontWeight: 400 }}>(optional — helps us improve)</span>
                </label>
                <select
                  value={closeReason}
                  onChange={e => setCloseReason(e.target.value)}
                  disabled={closeStep === "closing"}
                  style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, marginBottom: 10, background: "#fff", fontFamily: "inherit" }}
                >
                  <option value="">— select a reason —</option>
                  <option value="too_expensive">Too expensive</option>
                  <option value="not_enough_value">Not enough value</option>
                  <option value="switching_provider">Switching to another provider</option>
                  <option value="closed_dealership">Closed / sold the dealership</option>
                  <option value="seasonal_pause">Pausing for the season</option>
                  <option value="missing_feature">Missing a feature I need</option>
                  <option value="other">Other</option>
                </select>

                <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>
                  Anything else? <span style={{ color: "#9aa4ad", fontWeight: 400 }}>(optional)</span>
                </label>
                <textarea
                  value={closeDetail}
                  onChange={e => setCloseDetail(e.target.value)}
                  disabled={closeStep === "closing"}
                  rows={3}
                  placeholder="Tell us what wasn't working — we read every note."
                  style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
                />

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                  <button
                    onClick={() => setCloseStep(null)}
                    disabled={closeStep === "closing"}
                    style={{ padding: "7px 14px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c", fontFamily: "inherit" }}
                  >
                    Keep my account
                  </button>
                  <button
                    onClick={() => void closeAccount()}
                    disabled={closeStep === "closing"}
                    style={{ padding: "7px 14px", background: closeStep === "closing" ? "#9aa4ad" : "#c62828", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: closeStep === "closing" ? "default" : "pointer", fontFamily: "inherit" }}
                  >
                    {closeStep === "closing" ? "Closing…" : "Close account"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Outstanding Invoices ─────────────────────────────────────────── */}
      {outstandingInvoices.length > 0 && (
        <div style={{ border: "1px solid #ffcdd2", borderRadius: 6, padding: 20, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#c62828" }}>
              Outstanding Balance: {money(data.outstandingAmount)}
            </div>
            <div style={{ fontSize: 11, color: "#c62828", textTransform: "uppercase", letterSpacing: ".05em" }}>
              {outstandingInvoices.length} invoice{outstandingInvoices.length === 1 ? "" : "s"} due
            </div>
          </div>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #ffcdd2", textAlign: "left" }}>
                {["Invoice #", "Date", "Due", "Amount", ""].map((h) => (
                  <th key={h} style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#c62828", textTransform: "uppercase", letterSpacing: ".04em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {outstandingInvoices.map((inv, i) => (
                <tr key={inv.id} style={{ borderBottom: i < outstandingInvoices.length - 1 ? "1px solid #ffe6e6" : "none" }}>
                  <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 12 }}>#{inv.invoiceNumber ?? inv.id.slice(0, 8)}</td>
                  <td style={{ padding: "8px 10px", color: "#555" }}>{new Date(inv.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                  <td style={{ padding: "8px 10px", color: inv.status === "overdue" ? "#c62828" : "#555" }}>
                    {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: "monospace", color: "#333" }}>{money(inv.total)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right" }}>
                    <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                      <a href={`/api/billing/me/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>View</a>
                      <a href={`/api/billing/me/invoices/${inv.id}/pdf?download=1`} style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>Download</a>
                      {inv.paymentUrl && (
                        <a
                          href={inv.paymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ padding: "5px 14px", background: "#ffa500", color: "#fff", borderRadius: 4, fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-block" }}
                        >
                          Pay
                        </a>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Invoice History ──────────────────────────────────────────────── */}
      <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 20, background: "#fff" }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: "#2a2b3c", marginBottom: 12 }}>
          Invoice History
        </div>
        {paidInvoices.length === 0 ? (
          <div style={{ fontSize: 13, color: "#78828c" }}>No paid invoices yet.</div>
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0", textAlign: "left" }}>
                {["Invoice #", "Date", "Amount", "Status", ""].map((h) => (
                  <th key={h} style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".04em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paidInvoices.map((inv, i) => (
                <tr key={inv.id} style={{ borderBottom: i < paidInvoices.length - 1 ? "1px solid #f5f5f5" : "none" }}>
                  <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 12 }}>#{inv.invoiceNumber ?? inv.id.slice(0, 8)}</td>
                  <td style={{ padding: "8px 10px", color: "#555" }}>{new Date(inv.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                  <td style={{ padding: "8px 10px", fontFamily: "monospace", color: "#333" }}>{money(inv.total)}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", textTransform: "uppercase", letterSpacing: ".04em" }}>
                      Paid
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right" }}>
                    <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                      <a href={`/api/billing/me/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>View</a>
                      <a href={`/api/billing/me/invoices/${inv.id}/pdf?download=1`} style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>Download</a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function useCallbackFetch(
  setData: (d: BillingMeData) => void,
  setLoading: (b: boolean) => void,
  setError: (s: string | null) => void,
) {
  return useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/me");
      if (!res.ok) {
        setError("Failed to load billing");
        setLoading(false);
        return;
      }
      const j = (await res.json()) as BillingMeData;
      setData(j);
    } catch {
      setError("Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [setData, setLoading, setError]);
}

// ── Shared field component ────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  disabled,
  style,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, ...style }}>
      <label style={labelStyle}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={onChange}
        disabled={disabled}
        style={{
          display: "block",
          width: "100%",
          height: 36,
          padding: "0 10px",
          border: "1px solid #e0e0e0",
          borderRadius: 4,
          fontSize: 14,
          color: "#333",
          background: disabled ? "#f5f6f7" : "#fff",
          boxSizing: "border-box",
          outline: "none",
        }}
      />
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: "#78828c",
  marginBottom: 4,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 14,
};

const primaryBtn: React.CSSProperties = {
  background: "#1976d2",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  height: 36,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  color: "#1976d2",
  border: "1px solid #1976d2",
  borderRadius: 4,
  height: 36,
  padding: "0 14px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".05em",
  color: "#78828c",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 13,
  color: "#333",
};

// ── Main export ───────────────────────────────────────────────────────────────

const ALL_TABS: { id: Tab; label: string; dealerOnly?: boolean; staffOnly?: boolean }[] = [
  { id: "info", label: "Dealership Info", dealerOnly: true },
  { id: "shipping", label: "Shipping", dealerOnly: true },
  { id: "labels", label: "Order Labels", dealerOnly: true },
  { id: "orders", label: "Orders", dealerOnly: true },
  { id: "billing", label: "Billing", dealerOnly: true },
  // staffOnly: super_admin can see + use this when ghosting a dealer.
  // Dealer roles never see the tab; the route enforces the same gate
  // server-side (returns 403 for any non-super_admin caller).
  { id: "hubspot", label: "HubSpot Sync", dealerOnly: true, staffOnly: true },
  { id: "security", label: "Security" },
];

export default function ProfileClient({ dealer, canEdit, canOrderLabels, recommendedPaperSizes, userEmail, userName, userRole, memberSince }: Props) {
  const searchParams = useSearchParams();
  const hasDealer = !!dealer;
  const isStaff = userRole === "super_admin";
  const visibleTabs = ALL_TABS.filter(t => {
    if (t.dealerOnly && !hasDealer) return false;
    if (t.staffOnly && !isStaff) return false;
    return true;
  });

  // Reading searchParams inside a useState initializer causes a
  // hydration mismatch (React #425/#418/#423) because useSearchParams()
  // returns null on the server when the component isn't in a Suspense
  // boundary, but resolves to the real params during the first client
  // render. Initialize with a static default and sync from
  // searchParams in a useEffect after mount — both passes (SSR + first
  // client render) then produce the same tree.
  const [tab, setTab] = useState<Tab>(hasDealer ? "info" : "security");
  // ?upgrade=1 (from the sidebar "Upgrade Now" CTA) → open Billing's Change Plan
  // picker on load. Read in the same post-mount effect as ?tab= so it's
  // hydration-safe (useSearchParams is null on the server).
  const [openChangePlan, setOpenChangePlan] = useState(false);

  useEffect(() => {
    const t = searchParams.get("tab");
    if (searchParams.get("upgrade") === "1") setOpenChangePlan(true);
    if (t === "security") { setTab("security"); return; }
    if (!hasDealer) return;
    if (t === "labels" || t === "info" || t === "shipping" || t === "billing" || t === "orders") {
      setTab(t as Tab);
    } else if (t === "hubspot" && isStaff) {
      setTab("hubspot");
    }
  }, [searchParams, hasDealer, isStaff]);

  const title = "My Profile";

  return (
    <div>
      <PageHeader title={title} />

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "2px solid #e0e0e0",
          marginBottom: 24,
          background: "#fff",
          borderRadius: "6px 6px 0 0",
          overflow: "hidden",
        }}
      >
        {visibleTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "10px 20px",
              fontSize: 13,
              fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? "#1976d2" : "#55595c",
              background: "transparent",
              border: "none",
              borderBottom: tab === t.id ? "2px solid #1976d2" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -2,
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: "0 0 6px 6px",
          padding: "24px",
        }}
      >
        {tab === "info" && dealer && <InfoTab dealer={dealer} canEdit={canEdit} />}
        {tab === "shipping" && dealer && <ShippingTab dealer={dealer} canEdit={canEdit} />}
        {tab === "labels" && dealer && (
          <OrderLabelsTab
            dealer={dealer}
            canOrder={canOrderLabels}
            recommendedPaperSizes={recommendedPaperSizes}
            userEmail={userEmail}
            userName={userName}
          />
        )}
        {tab === "orders" && <OrdersTab />}
        {tab === "billing" && <BillingTab openChangePlan={openChangePlan} />}
        {tab === "hubspot" && dealer && isStaff && (
          <HubSpotSyncTab dealer={dealer} />
        )}
        {tab === "security" && (
          <SecurityTab userEmail={userEmail} userRole={userRole} memberSince={memberSince} />
        )}
      </div>
    </div>
  );
}
