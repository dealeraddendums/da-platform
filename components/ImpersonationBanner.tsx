"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type ImpersonateState = {
  dealer_name: string;
  dealer_id: string;
  original_access_token: string;
  original_refresh_token: string;
};

export default function ImpersonationBanner() {
  const [state, setState] = useState<ImpersonateState | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("da_impersonate");
      if (raw) setState(JSON.parse(raw) as ImpersonateState);
    } catch {
      localStorage.removeItem("da_impersonate");
    }
  }, []);

  async function handleExit() {
    if (!state || exiting) return;
    setExiting(true);
    const supabase = createClient();
    await supabase.auth.setSession({
      access_token: state.original_access_token,
      refresh_token: state.original_refresh_token,
    });
    localStorage.removeItem("da_impersonate");
    document.cookie = "da_impersonating=; path=/; max-age=0; SameSite=Lax";
    window.location.href = "/dealers";
  }

  if (!state) return null;

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
      <span>👁 Viewing as <strong>{state.dealer_name}</strong></span>
      <button
        onClick={() => void handleExit()}
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
