// Single source of truth for "is this dealer usable on V5.0?" — the same
// predicate the /not-migrated notice gate uses (app/(dashboard)/layout.tsx).
//
// A dealer account is usable on 5.0 when it is migrated, born-native, or carries
// a V5-native id prefix:
//   * migration_status === 'migrated'  — moved from 4.0
//   * is_native === true               — created on 5.0
//   * dealer_id starts with 'ss_'      — self-serve trial (lib/provisioning.ts)
//   * dealer_id starts with 'ga_'      — group_admin-created (app/api/dealers POST)
// A native renamed to a real inventory id gets migration_status='migrated' in the
// cascade, so it keeps passing after losing the prefix.

export type V5DealerRow =
  | { dealer_id?: string | null; migration_status?: string | null; is_native?: boolean | null }
  | null
  | undefined;

export function isDealerMigratedOnV5(d: V5DealerRow): boolean {
  if (!d) return false; // no dealers row resolved -> not usable on 5.0
  const id = d.dealer_id ?? "";
  return (
    d.migration_status === "migrated" ||
    d.is_native === true ||
    id.startsWith("ss_") ||
    id.startsWith("ga_")
  );
}

// Roles that are gated to their own dealer's migration state. Everyone else
// (super_admin, group_admin, group_user) is a platform operator for whom 5.0 is
// home — they are always usable on 5.0.
export const DEALER_ROLES = new Set(["dealer_admin", "dealer_user", "dealer_restricted"]);

export function isUsableOnV5(role: string | null | undefined, dealer: V5DealerRow): boolean {
  if (!role || !DEALER_ROLES.has(role)) return true; // operators: 5.0 is home
  return isDealerMigratedOnV5(dealer);               // dealer roles: dealer must be migrated/native AND resolve
}
