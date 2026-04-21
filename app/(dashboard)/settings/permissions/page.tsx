"use client";

import { useEffect, useState } from "react";
import type { UserPermissionsRow } from "@/lib/db";

const ROLE_TABS: { key: string; label: string }[] = [
  { key: "super_admin",  label: "Super Admin" },
  { key: "group_admin",  label: "Group Admin" },
  { key: "group_user",   label: "Group User" },
  { key: "dealer_admin", label: "Dealer Admin" },
  { key: "dealer_user",  label: "Dealer User" },
];

const PERMISSION_GROUPS: { label: string; keys: (keyof UserPermissionsRow)[] }[] = [
  {
    label: "Inventory",
    keys: ["can_view_inventory", "can_add_vehicles", "can_edit_vehicles", "can_delete_vehicles"],
  },
  {
    label: "Documents",
    keys: ["can_print_addendums", "can_print_infosheets", "can_use_builder"],
  },
  {
    label: "Options & Library",
    keys: ["can_view_options_library", "can_edit_options_library"],
  },
  {
    label: "Templates",
    keys: ["can_view_templates", "can_edit_templates"],
  },
  {
    label: "Reports & Data",
    keys: ["can_view_reports", "can_export_data"],
  },
  {
    label: "Settings",
    keys: ["can_view_settings", "can_edit_settings"],
  },
  {
    label: "Users",
    keys: ["can_manage_users"],
  },
  {
    label: "Dealers & Groups",
    keys: ["can_view_dealers", "can_edit_dealers", "can_view_groups", "can_edit_groups", "can_impersonate_dealers"],
  },
  {
    label: "Billing",
    keys: ["can_view_billing"],
  },
  {
    label: "AI & API",
    keys: ["can_use_ai_content", "can_manage_api_keys"],
  },
];

function permissionLabel(key: string): string {
  return key.replace(/^can_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export default function PermissionsPage() {
  const [permissions, setPermissions] = useState<Record<string, UserPermissionsRow>>({});
  const [activeRole, setActiveRole] = useState("dealer_admin");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedRole, setSavedRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string>("dealer_admin");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings/permissions");
      if (res.ok) {
        const data = await res.json() as { permissions: UserPermissionsRow[]; role: string };
        const map: Record<string, UserPermissionsRow> = {};
        for (const p of data.permissions) map[p.role] = p;
        setPermissions(map);
        setUserRole(data.role);
        // dealer_admin sees only dealer_admin/dealer_user
        if (data.role !== "super_admin") setActiveRole("dealer_admin");
      }
      setLoading(false);
    })();
  }, []);

  async function handleSave() {
    const perm = permissions[activeRole];
    if (!perm) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/settings/permissions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: activeRole, permissions: perm }),
    });
    if (res.ok) {
      setSavedRole(activeRole);
      setTimeout(() => setSavedRole(null), 2000);
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setError(body.error ?? "Save failed");
    }
    setSaving(false);
  }

  function toggle(key: keyof UserPermissionsRow) {
    setPermissions(prev => {
      const perm = prev[activeRole];
      if (!perm) return prev;
      return { ...prev, [activeRole]: { ...perm, [key]: !perm[key] } };
    });
  }

  const visibleRoles = userRole === "super_admin"
    ? ROLE_TABS
    : ROLE_TABS.filter(t => t.key === "dealer_admin" || t.key === "dealer_user");

  const perm = permissions[activeRole];
  const isSuper = userRole === "super_admin";

  if (loading) {
    return (
      <div className="p-6">
        <div style={{ color: "var(--text-inverse)", fontSize: 14 }}>Loading permissions…</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--text-inverse)" }}>
            Role Permissions
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.55)" }}>
            Configure what each role can do in the platform.
          </p>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !perm}
          className="px-4 text-sm font-medium text-white rounded"
          style={{
            height: 36,
            background: savedRole === activeRole ? "var(--success)" : "var(--blue)",
            border: "none",
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : savedRole === activeRole ? "Saved ✓" : "Save Changes"}
        </button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded text-sm" style={{ background: "#ffebee", color: "#c62828" }}>
          {error}
        </div>
      )}

      {/* Role tabs */}
      <div className="flex gap-1 mb-5" style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: 0 }}>
        {visibleRoles.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveRole(tab.key)}
            className="px-4 py-2 text-sm font-medium rounded-t"
            style={{
              background: activeRole === tab.key ? "var(--bg-surface)" : "transparent",
              color: activeRole === tab.key ? "var(--text-primary)" : "rgba(255,255,255,0.65)",
              border: "none",
              cursor: "pointer",
              borderBottom: activeRole === tab.key ? "2px solid var(--blue)" : "2px solid transparent",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Permissions grid */}
      {perm ? (
        <div
          className="rounded-lg"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
        >
          {PERMISSION_GROUPS.map((group, gi) => (
            <div
              key={group.label}
              style={{ borderBottom: gi < PERMISSION_GROUPS.length - 1 ? "1px solid var(--border)" : "none" }}
            >
              <div
                className="px-5 py-2 text-xs font-semibold uppercase tracking-wide"
                style={{
                  color: "var(--text-muted)",
                  background: "var(--bg-subtle)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {group.label}
              </div>
              <div className="px-5 py-3 grid grid-cols-1 gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
                {group.keys.map(key => {
                  const val = perm[key] as boolean;
                  const isLocked = !isSuper && activeRole === "super_admin";
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-3 cursor-pointer select-none"
                      style={{ opacity: isLocked ? 0.5 : 1 }}
                    >
                      <div
                        onClick={() => !isLocked && toggle(key as keyof UserPermissionsRow)}
                        style={{
                          width: 36,
                          height: 20,
                          borderRadius: 10,
                          background: val ? "var(--success)" : "var(--border-strong)",
                          position: "relative",
                          flexShrink: 0,
                          cursor: isLocked ? "not-allowed" : "pointer",
                          transition: "background 0.15s",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            top: 2,
                            left: val ? 18 : 2,
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            background: "white",
                            transition: "left 0.15s",
                          }}
                        />
                      </div>
                      <span className="text-sm" style={{ color: "var(--text-primary)" }}>
                        {permissionLabel(key as string)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card p-6 text-sm" style={{ color: "var(--text-muted)" }}>
          No permissions found for this role.
        </div>
      )}
    </div>
  );
}
