"use client";

import { useState, useEffect } from "react";
import type { VehicleRow } from "@/lib/vehicles";
import { parsePhotos, parseOptions, vehicleCondition } from "@/lib/vehicles";

type Props = {
  vehicle: VehicleRow;
  onClose: () => void;
};

export default function VehicleDetail({ vehicle: initialVehicle, onClose }: Props) {
  const [vehicle, setVehicle] = useState(initialVehicle);
  const [loadingFull, setLoadingFull] = useState(true);
  const [photoIndex, setPhotoIndex] = useState(0);

  // Fetch full vehicle details (includes OPTIONS, DESCRIPTION, all columns)
  useEffect(() => {
    setLoadingFull(true);
    setPhotoIndex(0);
    fetch(`/api/vehicles/${initialVehicle.id}`)
      .then((r) => r.json() as Promise<{ data: VehicleRow }>)
      .then((j) => { if (j.data) setVehicle(j.data); })
      .catch(() => {/* keep initialVehicle */})
      .finally(() => setLoadingFull(false));
  }, [initialVehicle.id]);

  const photos = parsePhotos(vehicle.PHOTOS);
  const options = parseOptions(vehicle.OPTIONS);
  const cond = vehicleCondition(vehicle);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-end",
        padding: 0,
      }}
      onClick={onClose}
    >
      {/* Slide-in panel */}
      <div
        style={{
          background: "var(--bg-surface)",
          width: "min(640px, 100vw)",
          height: "100vh",
          overflowY: "auto",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Panel header */}
        <div
          className="flex items-center justify-between px-6 py-4 sticky top-0"
          style={{ background: "var(--navy)", zIndex: 1 }}
        >
          <div>
            <h2 className="font-semibold text-base" style={{ color: "var(--text-inverse)" }}>
              {[vehicle.YEAR, vehicle.MAKE, vehicle.MODEL].filter(Boolean).join(" ")}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.5)" }}>
              {vehicle.TRIM || ""} {vehicle.TRIM ? "·" : ""} VIN {vehicle.VIN_NUMBER}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-sm"
            style={{ color: "rgba(255,255,255,0.6)" }}
          >
            ✕ Close
          </button>
        </div>

        {/* Photo gallery */}
        {photos.length > 0 && (
          <div style={{ background: "#000" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photos[photoIndex]}
              alt=""
              style={{ width: "100%", height: 280, objectFit: "contain" }}
            />
            {photos.length > 1 && (
              <div
                className="flex items-center justify-between px-4 py-2"
                style={{ background: "rgba(0,0,0,0.6)" }}
              >
                <button
                  style={{ color: "#fff", fontSize: 13 }}
                  disabled={photoIndex === 0}
                  onClick={() => setPhotoIndex((i) => i - 1)}
                >
                  ← Prev
                </button>
                <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>
                  {photoIndex + 1} / {photos.length}
                </span>
                <button
                  style={{ color: "#fff", fontSize: 13 }}
                  disabled={photoIndex === photos.length - 1}
                  onClick={() => setPhotoIndex((i) => i + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}

        <div className="p-6">
          {/* Key stats */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <Stat label="MSRP" value={vehicle.MSRP ? `$${parseInt(vehicle.MSRP, 10).toLocaleString()}` : "—"} highlight />
            <Stat label="Condition" value={cond} />
            <Stat label="Mileage" value={vehicle.MILEAGE ? parseInt(vehicle.MILEAGE, 10).toLocaleString() + " mi" : "—"} />
          </div>

          {/* Details grid */}
          <Section title="Vehicle Details">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Detail label="Stock #" value={vehicle.STOCK_NUMBER} />
              <Detail label="Year" value={vehicle.YEAR} />
              <Detail label="Make" value={vehicle.MAKE} />
              <Detail label="Model" value={vehicle.MODEL} />
              <Detail label="Trim" value={vehicle.TRIM} />
              <Detail label="Body Style" value={vehicle.BODYSTYLE} />
              <Detail label="Ext. Color" value={vehicle.EXT_COLOR} />
              <Detail label="Int. Color" value={vehicle.INT_COLOR} />
              <Detail label="Engine" value={vehicle.ENGINE} />
              <Detail label="Transmission" value={vehicle.TRANSMISSION} />
              <Detail label="Drivetrain" value={vehicle.DRIVETRAIN} />
              <Detail label="Fuel" value={vehicle.FUEL} />
              {(vehicle.HMPG || vehicle.CMPG) && (
                <Detail
                  label="MPG"
                  value={[vehicle.HMPG && `${vehicle.HMPG} hwy`, vehicle.CMPG && `${vehicle.CMPG} city`].filter(Boolean).join(" / ")}
                />
              )}
              <Detail label="Date In Stock" value={vehicle.DATE_IN_STOCK} />
            </div>
          </Section>

          {/* Options */}
          {loadingFull ? (
            <div className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>Loading details…</div>
          ) : options.length > 0 ? (
            <Section title={`Options (${options.length})`}>
              <div className="flex flex-wrap gap-1.5">
                {options.map((opt, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-1 rounded"
                    style={{ background: "var(--bg-subtle)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                  >
                    {opt}
                  </span>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Description */}
          {vehicle.DESCRIPTION && (
            <Section title="Description">
              <p className="text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {vehicle.DESCRIPTION}
              </p>
            </Section>
          )}

          {/* Actions */}
          <div
            className="pt-4 mt-4"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
              Open in Document Builder to create addendums and infosheets
            </p>
            <div className="flex gap-2">
              <a
                href={`/builder/${vehicle.id}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              >
                Open in Builder
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className="p-3 rounded text-center"
      style={{ background: highlight ? "#e3f2fd" : "var(--bg-subtle)", border: "1px solid var(--border)" }}
    >
      <div
        className="text-lg font-semibold"
        style={{ color: highlight ? "#1565c0" : "var(--text-primary)" }}
      >
        {value}
      </div>
      <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <p
        className="text-xs font-semibold uppercase tracking-wider mb-3"
        style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs" style={{ color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <span className="text-sm font-medium text-right" style={{ color: value ? "var(--text-primary)" : "var(--text-muted)" }}>
        {value || "—"}
      </span>
    </div>
  );
}
