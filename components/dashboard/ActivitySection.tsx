"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import type { DealerMapPoint } from "./MapboxMap";

const MapboxMap = dynamic(() => import("./MapboxMap"), { ssr: false });

export type { DealerMapPoint };

export type PrintEvent = {
  key: string;
  dealerUuid: string;
  dealerLegacyId: string;
  dealerName: string;
  dealerActive: boolean;
  printedAt: string;
};

type Tab = "all" | "paid" | "trial";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

export default function ActivitySection({ dealers }: { dealers: DealerMapPoint[] }) {
  const [prints, setPrints] = useState<PrintEvent[]>([]);
  const [flashingId, setFlashingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ name: string } | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const seenRef = useRef(new Set<string>());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dealerByUuidRef = useRef(new Map<string, DealerMapPoint>());

  // Build UUID lookup map when dealers change
  useEffect(() => {
    const m = new Map<string, DealerMapPoint>();
    for (const d of dealers) m.set(d.id, d);
    dealerByUuidRef.current = m;
  }, [dealers]);

  // Load initial print history
  useEffect(() => {
    fetch("/api/dashboard/recent-prints")
      .then(r => r.json())
      .then((d: { prints?: PrintEvent[] }) => {
        if (!d.prints) return;
        for (const p of d.prints) seenRef.current.add(p.key);
        setPrints(d.prints);
        // Flash most recent dealer if within last 5 min
        const cutoff = Date.now() - 5 * 60 * 1000;
        const recent = d.prints.find(p => new Date(p.printedAt).getTime() > cutoff);
        if (recent) setFlashingId(recent.dealerUuid);
      })
      .catch(() => {});
  }, []);

  // Supabase Realtime — subscribe to addendum_data INSERTs
  // Note: enable Realtime for addendum_data in Supabase Dashboard → Database → Replication
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("da-dashboard-prints")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "addendum_data" },
        (payload) => {
          const row = payload.new as {
            dealer_id: string;
            printed_at: string | null;
            vin_number: string | null;
          };

          // Deduplicate: all rows from the same print job share dealer_id + printed_at
          const key = `${row.dealer_id}:${row.printed_at ?? row.vin_number ?? String(Date.now())}`;
          if (seenRef.current.has(key)) return;
          seenRef.current.add(key);

          const dealer = dealerByUuidRef.current.get(row.dealer_id);
          if (!dealer) return;

          const event: PrintEvent = {
            key,
            dealerUuid: dealer.id,
            dealerLegacyId: dealer.dealer_id,
            dealerName: dealer.name,
            dealerActive: dealer.active,
            printedAt: row.printed_at ?? new Date().toISOString(),
          };

          setPrints(prev => [event, ...prev].slice(0, 50));

          setFlashingId(dealer.id);
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setFlashingId(null), 5 * 60 * 1000);

          setToast({ name: dealer.name });
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(() => setToast(null), 6000);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  // Impersonate dealer on ticker item click
  async function handleImpersonate(legacyDealerId: string) {
    if (impersonating) return;
    setImpersonating(legacyDealerId);
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    const res = await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: legacyDealerId }),
    });

    const json = await res.json() as {
      access_token?: string; refresh_token?: string;
      dealer_name?: string; dealer_id?: string; error?: string;
    };

    if (!res.ok || !json.access_token || !json.refresh_token) {
      alert(json.error ?? "Impersonation failed");
      setImpersonating(null);
      return;
    }

    localStorage.setItem("da_impersonate", JSON.stringify({
      dealer_name: json.dealer_name,
      dealer_id: json.dealer_id,
      original_access_token: session?.access_token ?? "",
      original_refresh_token: session?.refresh_token ?? "",
    }));

    await supabase.auth.setSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });

    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = "/dashboard";
  }

  // Tab-filtered prints and counts
  const filteredPrints = prints.filter(p =>
    tab === "paid" ? p.dealerActive :
    tab === "trial" ? !p.dealerActive :
    true
  );
  const counts = {
    all: prints.length,
    paid: prints.filter(p => p.dealerActive).length,
    trial: prints.filter(p => !p.dealerActive).length,
  };

  function timeAgo(iso: string) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 15) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  const mapSectionStyle: React.CSSProperties = {
    flex: "0 0 70%",
    position: "relative",
    overflow: "hidden",
  };

  const tickerSectionStyle: React.CSSProperties = {
    flex: "0 0 30%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  return (
    <div
      style={{
        display: "flex",
        height: 600,
        background: "#fff",
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* ── Map panel ────────────────────────────────────────────────────────── */}
      <div style={mapSectionStyle}>
        {!TOKEN || TOKEN === "pk.your_token_here" ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              background: "#f5f6f7",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#78828c" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <p style={{ fontSize: 13, color: "#78828c", textAlign: "center", margin: 0 }}>
              Add <code style={{ background: "#e0e0e0", padding: "1px 4px", borderRadius: 3 }}>NEXT_PUBLIC_MAPBOX_TOKEN</code> to <code style={{ background: "#e0e0e0", padding: "1px 4px", borderRadius: 3 }}>.env.local</code>
            </p>
            <p style={{ fontSize: 12, color: "#78828c", margin: 0 }}>
              Get a free token at account.mapbox.com
            </p>
          </div>
        ) : (
          <MapboxMap dealers={dealers} flashingDealerId={flashingId} token={TOKEN} visibleTab={tab} />
        )}

        {/* JUST NOW toast */}
        {toast && (
          <div
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              background: "#2a2b3c",
              color: "#fff",
              borderRadius: 6,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 500,
              maxWidth: 240,
              zIndex: 10,
              boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
              animation: "fadeInDown 0.2s ease",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>🖨</span>
            <div>
              <div style={{ fontWeight: 600 }}>{toast.name}</div>
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>printed an addendum just now</div>
            </div>
            <button
              onClick={() => setToast(null)}
              style={{
                background: "none", border: "none", color: "rgba(255,255,255,0.6)",
                cursor: "pointer", fontSize: 16, padding: 0, marginLeft: "auto", lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Map legend */}
        <div
          style={{
            position: "absolute",
            bottom: 28,
            left: 12,
            background: "rgba(255,255,255,0.92)",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 11,
            display: "flex",
            flexDirection: "column",
            gap: 5,
            zIndex: 1,
          }}
        >
          {[
            { color: "#4caf50", label: "Active" },
            { color: "#1976d2", label: "Trial / Inactive" },
            { color: "#ff5252", label: "Printed recently" },
          ].map(({ color, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, border: "1px solid rgba(255,255,255,0.8)" }} />
              <span style={{ color: "#55595c" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Divider ───────────────────────────────────────────────────────────── */}
      <div style={{ width: 1, background: "#e0e0e0", flexShrink: 0 }} />

      {/* ── Ticker panel ──────────────────────────────────────────────────────── */}
      <div style={tickerSectionStyle}>
        {/* Panel header */}
        <div
          style={{
            padding: "12px 14px 10px",
            borderBottom: "1px solid #e0e0e0",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13, color: "#2a2b3c", marginBottom: 8 }}>
            Live Activity
          </div>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 0, borderBottom: "2px solid #e0e0e0", marginBottom: -10, paddingBottom: 0 }}>
            {(["all", "paid", "trial"] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom: tab === t ? "2px solid #1976d2" : "2px solid transparent",
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: tab === t ? 700 : 500,
                  color: tab === t ? "#1976d2" : "#78828c",
                  cursor: "pointer",
                  textTransform: "uppercase" as const,
                  letterSpacing: ".04em",
                  marginBottom: -2,
                  whiteSpace: "nowrap" as const,
                }}
              >
                {t}&nbsp;
                <span
                  style={{
                    background: tab === t ? "#e3f2fd" : "#f5f6f7",
                    color: tab === t ? "#1565c0" : "#78828c",
                    borderRadius: 20,
                    padding: "0 5px",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {counts[t]}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable ticker list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          <style>{`
            @keyframes fadeInDown {
              from { opacity: 0; transform: translateY(-6px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            .ticker-row:hover { background: #f5f6f7; }
          `}</style>

          {filteredPrints.length === 0 ? (
            <div
              style={{
                padding: "24px 16px",
                fontSize: 13,
                color: "#78828c",
                textAlign: "center",
              }}
            >
              {prints.length === 0 ? "No recent prints." : "No prints in this category."}
            </div>
          ) : (
            filteredPrints.map(p => (
              <div
                key={p.key}
                className="ticker-row"
                title={`Click to impersonate ${p.dealerName}`}
                onClick={() => void handleImpersonate(p.dealerLegacyId)}
                style={{
                  padding: "9px 14px",
                  borderBottom: "1px solid #f0f0f0",
                  cursor: impersonating ? "default" : "pointer",
                  opacity: impersonating === p.dealerLegacyId ? 0.6 : 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: p.dealerActive ? "#4caf50" : "#1976d2",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      color: "#333",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.dealerName}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#78828c", paddingLeft: 13 }}>
                  printed {timeAgo(p.printedAt)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
