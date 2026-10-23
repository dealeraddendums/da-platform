"use client";

// Contacts list: remember each user's sort / direction / group-by choice (localStorage, per user). With no
// choice in the URL, the saved one is applied; any choice in the URL is saved.
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const KEYS = ["s", "d", "g"] as const;

export default function ContactsViewPrefs({ userId }: { userId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  useEffect(() => {
    const storeKey = `crm:contacts-view:${userId}`;
    const inUrl = KEYS.some((k) => sp.has(k));
    try {
      if (inUrl) {
        localStorage.setItem(storeKey, JSON.stringify(Object.fromEntries(KEYS.filter((k) => sp.has(k)).map((k) => [k, sp.get(k)]))));
        return;
      }
      const saved = JSON.parse(localStorage.getItem(storeKey) || "null") as Record<string, string> | null;
      if (!saved || !KEYS.some((k) => saved[k])) return;
      const next = new URLSearchParams(sp.toString());
      for (const k of KEYS) if (saved[k]) next.set(k, saved[k]);
      router.replace(`${pathname}?${next.toString()}`);
    } catch { /* private mode / blocked storage: defaults apply */ }
  }, [sp, pathname, router, userId]);
  return null;
}
