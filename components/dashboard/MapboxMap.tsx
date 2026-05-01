"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

export type DealerMapPoint = {
  id: string;
  dealer_id: string;
  name: string;
  account_type: string | null;
  lat: string | null;
  lng: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

// Paid = active subscription; Free/Trial/null = trial
// Actual DB values (confirmed from production data):
const PAID_TYPES = new Set([
  "Automatic Web",
  "Automatic DMS",
  "Manual",
  "Standard",
  "Automatic Web $135",
]);

export function isPaidDealer(accountType: string | null | undefined): boolean {
  return !!accountType && PAID_TYPES.has(accountType);
}

type Props = {
  dealers: DealerMapPoint[];
  flashingDealerId: string | null;
  token: string;
  visibleTab: "all" | "paid" | "trial";
};

type MarkerInfo = { marker: mapboxgl.Marker; el: HTMLElement; dealer: DealerMapPoint };

export default function MapboxMap({ dealers, flashingDealerId, token, visibleTab }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef(new Map<string, MarkerInfo>());
  const prevFlashRef = useRef<string | null>(null);
  const dealersRef = useRef(dealers);
  dealersRef.current = dealers;
  const visibleTabRef = useRef(visibleTab);
  visibleTabRef.current = visibleTab;

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-96, 38],
      zoom: 4,
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, [token]);

  // Add markers once per dealer (runs when dealers array changes)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function addMarkers() {
      dealersRef.current.forEach(dealer => {
        if (markersRef.current.has(dealer.id)) return;
        const lat = dealer.lat ? parseFloat(dealer.lat) : null;
        const lng = dealer.lng ? parseFloat(dealer.lng) : null;
        if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

        const isFlashing = dealer.id === prevFlashRef.current;
        const paid = isPaidDealer(dealer.account_type);
        const color = isFlashing ? "#ff5252" : (paid ? "#4caf50" : "#1976d2");

        const el = document.createElement("div");
        el.className = isFlashing ? "da-marker da-marker-flash" : "da-marker";
        el.innerHTML = markerHtml(color);

        const addr = ([dealer.address, [dealer.city, dealer.state].filter(Boolean).join(", ") + (dealer.zip ? ` ${dealer.zip}` : "")] as (string | null)[]).filter((s): s is string => !!s);
        const popup = new mapboxgl.Popup({ offset: 14, closeButton: true, maxWidth: "220px" }).setHTML(
          `<div style="font-family:Roboto,sans-serif"><div style="font-weight:600;font-size:13px;color:#2a2b3c;margin-bottom:3px">${escHtml(dealer.name)}</div>${addr.map(a => `<div style="font-size:12px;color:#78828c">${escHtml(a)}</div>`).join("")}</div>`
        );

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([lng, lat])
          .setPopup(popup)
          .addTo(map!);

        markersRef.current.set(dealer.id, { marker, el, dealer });

        const tab = visibleTabRef.current;
        if (tab === "paid" && !paid) el.style.display = "none";
        else if (tab === "trial" && paid) el.style.display = "none";
      });
    }

    if (map.loaded()) addMarkers();
    else map.on("load", addMarkers);
  }, [dealers]);

  // Show/hide markers when tab changes
  useEffect(() => {
    markersRef.current.forEach(({ el, dealer }) => {
      const paid = isPaidDealer(dealer.account_type);
      if (visibleTab === "all") el.style.display = "";
      else if (visibleTab === "paid") el.style.display = paid ? "" : "none";
      else el.style.display = paid ? "none" : "";
    });
  }, [visibleTab]);

  // Update flash state imperatively (no full re-render of markers)
  useEffect(() => {
    const prev = prevFlashRef.current;
    if (prev === flashingDealerId) return;

    if (prev) {
      const info = markersRef.current.get(prev);
      if (info) {
        info.el.className = "da-marker";
        const mc = info.el.querySelector(".mc") as HTMLElement | null;
        if (mc) mc.style.background = isPaidDealer(info.dealer.account_type) ? "#4caf50" : "#1976d2";
      }
    }
    if (flashingDealerId) {
      const info = markersRef.current.get(flashingDealerId);
      if (info) {
        info.el.className = "da-marker da-marker-flash";
        const mc = info.el.querySelector(".mc") as HTMLElement | null;
        if (mc) mc.style.background = "#ff5252";
      }
    }

    prevFlashRef.current = flashingDealerId;
  }, [flashingDealerId]);

  return (
    <>
      <style>{`
        .da-marker { cursor: default; }
        .mc {
          width: 22px; height: 22px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.95);
          box-shadow: 0 1px 5px rgba(0,0,0,0.28);
          display: flex; align-items: center; justify-content: center;
          transition: background 0.2s;
        }
        .da-marker-flash .mc {
          animation: mkpulse 0.9s ease-in-out infinite;
          cursor: pointer;
        }
        @keyframes mkpulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,82,82,0.55); }
          50%       { transform: scale(1.4); box-shadow: 0 0 0 9px rgba(255,82,82,0); }
        }
        .mapboxgl-popup-content {
          padding: 10px 12px !important;
          border-radius: 6px !important;
          box-shadow: 0 2px 16px rgba(0,0,0,0.13) !important;
          border: 1px solid #e0e0e0 !important;
        }
        .mapboxgl-popup-close-button { color: #78828c; font-size: 16px; }
      `}</style>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </>
  );
}

function markerHtml(color: string) {
  return `<div class="mc" style="background:${color}"><svg width="11" height="11" viewBox="0 0 24 24" fill="white"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg></div>`;
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
