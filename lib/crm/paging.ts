// Link-mode paging for server-rendered /crm lists (pairs with components/Pager).

export function pageHref(base: string, params: Record<string, string | undefined>, page: number): string {
  const sp = new URLSearchParams(Object.entries(params).filter(([k, v]) => v && k !== "page") as [string, string][]);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}
