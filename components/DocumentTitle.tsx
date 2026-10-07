"use client";

import { useEffect } from "react";

/** Sets the browser-tab title from inside a view that shares a page with
 *  others (the page-level `metadata` is static, one title per route). */
export default function DocumentTitle({ title }: { title: string }) {
  useEffect(() => { document.title = title; }, [title]);
  return null;
}
