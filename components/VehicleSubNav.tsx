"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Inventory", href: "/vehicles" },
  { label: "Addendum Options", href: "/options" },
];

export default function VehicleSubNav() {
  const pathname = usePathname();

  return (
    <div style={{ background: "var(--orange)", borderRadius: 6, marginBottom: 20, display: "flex", overflow: "hidden" }}>
      {TABS.map(tab => {
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            style={{
              padding: "9px 18px",
              fontSize: 13,
              fontWeight: isActive ? 700 : 500,
              color: "#333",
              textDecoration: "none",
              background: isActive ? "rgba(0,0,0,0.13)" : "transparent",
              borderBottom: isActive ? "3px solid rgba(0,0,0,0.25)" : "3px solid transparent",
              transition: "background 100ms",
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
