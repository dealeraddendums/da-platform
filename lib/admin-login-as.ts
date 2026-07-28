"use client";

// One-click "Login" from the super_admin dealer/group profile headers.
// Composes the two EXISTING entry flows — no new session machinery:
//   1. Impersonation (preferred): POST /api/admin/impersonate {dealer_id}
//      picks the dealer's dealer_admin; /api/admin/impersonate-group picks a
//      group_admin. Token handling/localStorage/cookies mirror
//      DealerList.handleImpersonate / GroupList.handleGroupImpersonate.
//   2. Ghost Mode (fallback when the impersonate endpoint 404s = no suitable
//      user): POST /api/admin/ghost — mirrors the list components' handlers.
// Both underlying routes write admin_audit themselves.
import { createClient } from "@/lib/supabase/client";

/** Returns an error message, or never (navigates away on success). */
export async function loginAsDealer(dealer: { uuid: string; textId: string; name: string }): Promise<string> {
  const supabase = createClient();
  const { data: { session: currentSession } } = await supabase.auth.getSession();

  const res = await fetch("/api/admin/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dealer_id: dealer.textId }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; dealer_name?: string; dealer_id?: string; error?: string };

  if (res.ok && json.access_token && json.refresh_token) {
    localStorage.setItem("da_impersonate", JSON.stringify({
      dealer_name: json.dealer_name,
      dealer_id: json.dealer_id,
      original_access_token: currentSession?.access_token ?? "",
      original_refresh_token: currentSession?.refresh_token ?? "",
    }));
    const { error: setError } = await supabase.auth.setSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });
    if (setError) { localStorage.removeItem("da_impersonate"); return setError.message; }
    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = "/dashboard";
    return "";
  }

  // 404 = no impersonable user → Ghost Mode. Any other failure is a real error.
  if (res.status !== 404) return json.error ?? "Failed to log in to the dealer";

  const gres = await fetch("/api/admin/ghost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dealer_id: dealer.uuid }),
  });
  const gjson = (await gres.json()) as { ok?: boolean; dealer_text_id?: string; dealer_name?: string; dealer_uuid?: string; error?: string };
  if (!gres.ok || !gjson.ok) return gjson.error ?? "Failed to enter ghost mode";
  localStorage.setItem("da_ghost", JSON.stringify({
    dealer_name: gjson.dealer_name ?? dealer.name,
    dealer_text_id: gjson.dealer_text_id ?? dealer.textId,
    dealer_uuid: gjson.dealer_uuid ?? dealer.uuid,
  }));
  window.location.href = "/dashboard";
  return "";
}

/** Returns an error message, or never (navigates away on success). */
export async function loginAsGroup(group: { id: string; name: string }): Promise<string> {
  const supabase = createClient();
  const { data: { session: currentSession } } = await supabase.auth.getSession();

  const res = await fetch("/api/admin/impersonate-group", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: group.id }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; group_name?: string; target_email?: string; error?: string };

  if (res.ok && json.access_token && json.refresh_token) {
    localStorage.setItem("da_impersonate", JSON.stringify({
      dealer_name: json.target_email ? `${group.name} (Group — as ${json.target_email})` : `${group.name} (Group)`,
      dealer_id: group.id,
      original_access_token: currentSession?.access_token ?? "",
      original_refresh_token: currentSession?.refresh_token ?? "",
    }));
    const { error: setError } = await supabase.auth.setSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });
    if (setError) { localStorage.removeItem("da_impersonate"); return setError.message; }
    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    // Land at GROUP level, not the impersonated admin's last active dealer (#116).
    document.cookie = "da_group_level=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = "/groups";
    return "";
  }

  if (res.status !== 404) return json.error ?? "Failed to log in to the group";

  const gres = await fetch("/api/admin/ghost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: group.id }),
  });
  const gjson = (await gres.json()) as { ok?: boolean; group_id?: string; group_name?: string; error?: string };
  if (!gres.ok || !gjson.ok) return gjson.error ?? "Failed to enter ghost mode";
  localStorage.setItem("da_ghost", JSON.stringify({ group_id: gjson.group_id ?? group.id, group_name: gjson.group_name ?? group.name }));
  window.location.href = `/groups/${group.id}`;
  return "";
}
