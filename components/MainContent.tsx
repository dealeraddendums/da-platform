"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export default function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isBuilder = pathname.startsWith("/builder");
  // DA-CRM has its own look (app/(dashboard)/crm/crm-theme.css).
  const isCrm = pathname === "/crm" || pathname.startsWith("/crm/");
  return (
    <main
      className={`flex-1 relative${isBuilder ? " overflow-hidden" : " overflow-auto p-6"}${isCrm ? " crm-theme" : ""}`}
      style={{ background: "var(--bg-app)" }}
    >
      {children}
    </main>
  );
}
