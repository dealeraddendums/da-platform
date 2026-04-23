"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export default function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isBuilder = pathname.startsWith("/builder");
  return (
    <main
      className={`flex-1 relative${isBuilder ? " overflow-hidden" : " overflow-auto p-6"}`}
      style={{ background: "var(--bg-app)" }}
    >
      {children}
    </main>
  );
}
