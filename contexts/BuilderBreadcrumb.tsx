"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type Ctx = { title: string | null; setTitle: (t: string | null) => void };

const BuilderBreadcrumbCtx = createContext<Ctx>({ title: null, setTitle: () => {} });

export function BuilderBreadcrumbProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <BuilderBreadcrumbCtx.Provider value={{ title, setTitle }}>
      {children}
    </BuilderBreadcrumbCtx.Provider>
  );
}

export function useBuilderBreadcrumb() {
  return useContext(BuilderBreadcrumbCtx);
}
