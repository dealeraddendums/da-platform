"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type ImpersonateState = {
  dealer_name: string;
  dealer_id: string;
  original_access_token: string;
  original_refresh_token: string;
};

type GhostState = {
  dealer_name: string;
  dealer_text_id: string;
  dealer_uuid: string;
};

export default function ImpersonationBanner() {
  const [impersonateState, setImpersonateState] = useState<ImpersonateState | null>(null);
  const [ghostState, setGhostState] = useState<GhostState | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("da_impersonate");
      if (raw) {
        setImpersonateState(JSON.parse(raw) as ImpersonateState);
        return; // impersonation takes priority
      }
    } catch {
      localStorage.removeItem("da_impersonate");
    }
    try {
      const raw = localStorage.getItem("da_ghost");
      if (raw) setGhostState(JSON.parse(raw) as GhostState);
    } catch {
      localStorage.removeItem("da_ghost");
    }
  }, []);

  async function handleExitImpersonate() {
    if (!impersonateState || exiting) return;
    setExiting(true);
    const supabase = createClient();
    await supabase.auth.setSession({
      access_token: impersonateState.original_access_token,
      refresh_token: impersonateState.original_refresh_token,
    });
    localStorage.removeItem("da_impersonate");
    document.cookie = "da_impersonating=; path=/; max-age=0; SameSite=Lax";
    window.location.href = "/dealers";
  }

  async function handleExitGhost() {
    if (!ghostState || exiting) return;
    setExiting(true);
    try {
      await fetch("/api/admin/ghost/exit", { method: "POST" });
    } catch {
      // ignore network errors — still clear local state
    }
    localStorage.removeItem("da_ghost");
    document.cookie = "da_ghost_token=; path=/; max-age=0; SameSite=Lax";
    window.location.href = "/dealers";
  }

  // Impersonation banner (regular mode — has a real session swap)
  if (impersonateState) {
    return (
      <div
        style={{
          background: "#ffa500",
          color: "#333",
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontSize: 13,
          fontWeight: 500,
          flexShrink: 0,
          zIndex: 9999,
        }}
      >
        <span>👁 Viewing as <strong>{impersonateState.dealer_name}</strong></span>
        <button
          onClick={() => void handleExitImpersonate()}
          disabled={exiting}
          style={{
            background: "#333",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            height: 24,
            padding: "0 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: exiting ? "not-allowed" : "pointer",
            opacity: exiting ? 0.6 : 1,
          }}
        >
          {exiting ? "Exiting…" : "Exit"}
        </button>
      </div>
    );
  }

  // Ghost mode banner (no real session swap — super_admin stays logged in)
  if (ghostState) {
    return (
      <div
        style={{
          background: "#ffa500",
          color: "#333",
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontSize: 13,
          fontWeight: 500,
          flexShrink: 0,
          zIndex: 9999,
        }}
      >
        <span>👻 Ghost Mode — <strong>{ghostState.dealer_name}</strong> — Operating without a user account</span>
        <button
          onClick={() => void handleExitGhost()}
          disabled={exiting}
          style={{
            background: "#333",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            height: 24,
            padding: "0 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: exiting ? "not-allowed" : "pointer",
            opacity: exiting ? 0.6 : 1,
          }}
        >
          {exiting ? "Exiting…" : "Exit Ghost Mode"}
        </button>
      </div>
    );
  }

  return null;
}
