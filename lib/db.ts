import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export type UserRole =
  | "super_admin"
  | "group_admin"
  | "dealer_admin"
  | "dealer_user";

export type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  dealer_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProfileInsert = {
  id: string;
  email: string;
  full_name?: string | null;
  role?: UserRole;
  dealer_id?: string | null;
};

type ProfileUpdate = {
  email?: string;
  full_name?: string | null;
  role?: UserRole;
  dealer_id?: string | null;
  updated_at?: string;
};

// Database type shaped exactly as Supabase's generated types expect.
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: ProfileInsert;
        Update: ProfileUpdate;
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

/** Server client — uses request cookies for auth, respects RLS. */
export function createServerSupabaseClient() {
  const cookieStore = cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — cookie mutations are no-ops
          }
        },
      },
    }
  );
}

/** Service-role client — bypasses RLS, for admin operations only. */
export function createAdminSupabaseClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-role-key",
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
