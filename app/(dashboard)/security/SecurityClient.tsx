"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

// ── Types ─────────────────────────────────────────────────────────────────────

type PasskeyRow = {
  id: string;
  friendly_name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
};

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  group_admin: "Group Admin",
  group_user: "Group User",
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
  dealer_restricted: "Dealer User",
};

// ── Shared styles ─────────────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  background: "#1976d2",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  height: 36,
  padding: "0 16px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

// ── PasskeysCard ──────────────────────────────────────────────────────────────

function PasskeysCard() {
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
    void fetchPasskeys();
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        credential = await startRegistration({ optionsJSON: options as any });
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
    } catch { /* ignore */ }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        padding: "24px",
        marginBottom: 20,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#2a2b3c", margin: "0 0 4px" }}>
          Passkeys
        </h2>
        <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
          Sign in faster with Face ID, Touch ID, or your device PIN instead of a password.
        </p>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "#78828c", padding: "8px 0" }}>Loading…</div>
      ) : passkeys.length === 0 ? (
        <div
          style={{
            background: "#f5f6f7",
            border: "1px solid #e0e0e0",
            borderRadius: 4,
            padding: "12px 14px",
            fontSize: 13,
            color: "#78828c",
            marginBottom: 16,
          }}
        >
          No passkeys registered. Add one below to enable faster sign-in.
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
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
                      onKeyDown={e => {
                        if (e.key === "Enter") void handleRename(pk.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      style={{
                        height: 28, padding: "0 8px",
                        border: "1px solid #1976d2", borderRadius: 4,
                        fontSize: 13, outline: "none", width: 160,
                      }}
                    />
                    <button
                      onClick={() => void handleRename(pk.id)}
                      style={{ ...primaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      style={{
                        background: "transparent", color: "#1976d2",
                        border: "1px solid #1976d2", borderRadius: 4,
                        height: 28, padding: "0 10px", fontSize: 12, cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#2a2b3c" }}>
                      {pk.friendly_name}
                    </span>
                    {pk.device_type === "multiDevice" && (
                      <span
                        style={{
                          fontSize: 11, background: "#e3f2fd", color: "#1565c0",
                          border: "1px solid #bbdefb", borderRadius: 20,
                          padding: "1px 6px", fontWeight: 600,
                        }}
                      >
                        {pk.backed_up ? "☁ Cloud" : "Cross-Platform"}
                      </span>
                    )}
                    {pk.device_type === "singleDevice" && (
                      <span
                        style={{
                          fontSize: 11, background: "#f3e5f5", color: "#6a1b9a",
                          border: "1px solid #e1bee7", borderRadius: 20,
                          padding: "1px 6px", fontWeight: 600,
                        }}
                      >
                        Platform
                      </span>
                    )}
                    <button
                      onClick={() => { setEditingId(pk.id); setEditName(pk.friendly_name); }}
                      style={{
                        background: "none", border: "none", color: "#78828c",
                        cursor: "pointer", fontSize: 12, padding: "0 2px",
                      }}
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
                onClick={() => void handleDelete(pk.id)}
                disabled={deletingId === pk.id}
                style={{
                  background: "none", border: "1px solid #ffcdd2", borderRadius: 4,
                  color: "#c62828", cursor: "pointer", fontSize: 12,
                  padding: "4px 10px", flexShrink: 0,
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
        <div style={{ fontSize: 13, color: "#2e7d32", marginBottom: 10 }}>
          Passkey added successfully.
        </div>
      )}

      {supported ? (
        <button onClick={() => void handleAdd()} disabled={adding} style={{ ...primaryBtn, opacity: adding ? 0.6 : 1 }}>
          {adding
            ? "Waiting for device…"
            : passkeys.length === 0
            ? "+ Add Passkey"
            : "+ Add Another Passkey"}
        </button>
      ) : (
        <p style={{ fontSize: 12, color: "#78828c", margin: 0 }}>
          Passkeys require a device with Face ID, Touch ID, or a PIN. Not supported in this browser.
        </p>
      )}
    </div>
  );
}

// ── AccountInfoCard ───────────────────────────────────────────────────────────

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

  const roleBadgeStyle: React.CSSProperties = {
    display: "inline-block",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 20,
    background: "#e3f2fd",
    color: "#1565c0",
  };

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        padding: "24px",
      }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "#2a2b3c", margin: "0 0 16px" }}>
        Account Info
      </h2>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 2 }}>
            Email
          </div>
          <div style={{ fontSize: 14, color: "#2a2b3c" }}>{userEmail}</div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 4 }}>
            Role
          </div>
          <span style={roleBadgeStyle}>{ROLE_LABELS[userRole] ?? userRole}</span>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 2 }}>
            Member Since
          </div>
          <div style={{ fontSize: 14, color: "#2a2b3c" }}>{memberDate}</div>
        </div>

        <div style={{ paddingTop: 4 }}>
          <a
            href="/reset-password"
            style={{
              display: "inline-block",
              fontSize: 13,
              color: "#1976d2",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Change Password →
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function SecurityClient({
  userEmail,
  userRole,
  memberSince,
}: {
  userEmail: string;
  userRole: string;
  memberSince: string;
}) {
  return (
    <div>
      <PageHeader
        title="Security"
        subtitle="Manage your sign-in methods and account security."
      />
      <div style={{ maxWidth: 640 }}>
        <PasskeysCard />
        <AccountInfoCard
          userEmail={userEmail}
          userRole={userRole}
          memberSince={memberSince}
        />
      </div>
    </div>
  );
}
