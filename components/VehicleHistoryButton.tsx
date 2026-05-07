"use client";

import { useState } from "react";
import VehicleHistoryPanel from "./VehicleHistoryPanel";

export default function VehicleHistoryButton({
  vehicleId,
  stockNumber,
}: {
  vehicleId: string;
  stockNumber: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          height: 32, padding: "0 14px", fontSize: 13,
          background: "rgba(255,255,255,0.15)", color: "#fff",
          border: "1px solid rgba(255,255,255,0.3)", borderRadius: 4,
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        View History
      </button>
      {open && (
        <VehicleHistoryPanel
          vehicleId={vehicleId}
          stockNumber={stockNumber}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
