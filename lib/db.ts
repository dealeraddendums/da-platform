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
  group_id: string | null;
  created_at: string;
  updated_at: string;
};

type ProfileInsert = {
  id: string;
  email: string;
  full_name?: string | null;
  role?: UserRole;
  dealer_id?: string | null;
  group_id?: string | null;
};

type ProfileUpdate = {
  email?: string;
  full_name?: string | null;
  role?: UserRole;
  dealer_id?: string | null;
  group_id?: string | null;
  updated_at?: string;
};

export type GroupRow = {
  id: string;
  name: string;
  active: boolean;
  account_type: string;
  internal_id: string | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  billing_contact: string | null;
  billing_email: string | null;
  billing_phone: string | null;
  created_at: string;
  updated_at: string;
};

type GroupInsert = {
  name: string;
  active?: boolean;
  account_type?: string;
  internal_id?: string | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  billing_contact?: string | null;
  billing_email?: string | null;
  billing_phone?: string | null;
};

export type GroupUpdate = {
  name?: string;
  active?: boolean;
  account_type?: string;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  billing_contact?: string | null;
  billing_email?: string | null;
  billing_phone?: string | null;
};

export type DealerRow = {
  id: string;
  dealer_id: string;
  /** Never-changing billing ID (_ID). Used by da-billing for lineItemDescription. Never update. */
  internal_id: string | null;
  /** Inventory supplier-assigned ID. Matches Aurora DEALER_ID for inventory queries. */
  inventory_dealer_id: string | null;
  name: string;
  active: boolean;
  account_type: string;
  group_id: string | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  makes: string[];
  created_at: string;
  updated_at: string;
};

type DealerInsert = {
  dealer_id: string;
  internal_id?: string | null;
  inventory_dealer_id?: string | null;
  name: string;
  active?: boolean;
  account_type?: string;
  group_id?: string | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  makes?: string[];
};

export type DealerUpdate = {
  name?: string;
  /** inventory_dealer_id can be updated by super_admin when feed goes live. internal_id must never be updated. */
  inventory_dealer_id?: string | null;
  active?: boolean;
  account_type?: string;
  group_id?: string | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  makes?: string[];
};

export type TemplateRow = {
  id: string;
  dealer_id: string;
  name: string;
  document_type: "addendum" | "infosheet";
  vehicle_types: string[];
  template_json: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TemplateInsert = {
  dealer_id: string;
  name: string;
  document_type: "addendum" | "infosheet";
  vehicle_types?: string[];
  template_json?: Record<string, unknown>;
  is_active?: boolean;
};

export type TemplateUpdate = {
  name?: string;
  document_type?: "addendum" | "infosheet";
  vehicle_types?: string[];
  template_json?: Record<string, unknown>;
  is_active?: boolean;
  updated_at?: string;
};

export type DealerSettingsRow = {
  dealer_id: string;
  ai_content_default: boolean;
  nudge_left: number;
  nudge_right: number;
  nudge_top: number;
  nudge_bottom: number;
  default_template_new: string | null;
  default_template_used: string | null;
  default_template_cpo: string | null;
  updated_at: string;
};

type DealerSettingsInsert = {
  dealer_id: string;
  ai_content_default?: boolean;
  nudge_left?: number;
  nudge_right?: number;
  nudge_top?: number;
  nudge_bottom?: number;
  default_template_new?: string | null;
  default_template_used?: string | null;
  default_template_cpo?: string | null;
};

export type DealerSettingsUpdate = {
  ai_content_default?: boolean;
  nudge_left?: number;
  nudge_right?: number;
  nudge_top?: number;
  nudge_bottom?: number;
  default_template_new?: string | null;
  default_template_used?: string | null;
  default_template_cpo?: string | null;
  updated_at?: string;
};

export type AiContentCacheRow = {
  id: string;
  vin: string;
  dealer_id: string;
  description: string | null;
  features: [string, string][] | null;
  generated_at: string;
  model_version: string | null;
};

export type VehicleOptionRow = {
  id: string;
  vehicle_id: number;
  dealer_id: string;
  option_name: string;
  option_price: string;
  sort_order: number;
  active: boolean;
  source: "default" | "manual";
  created_at: string;
  updated_at: string;
};

type VehicleOptionInsert = {
  vehicle_id: number;
  dealer_id: string;
  option_name: string;
  option_price?: string;
  sort_order?: number;
  active?: boolean;
  source?: "default" | "manual";
};

type VehicleOptionUpdate = {
  option_name?: string;
  option_price?: string;
  sort_order?: number;
  active?: boolean;
  updated_at?: string;
};

export type PrintHistoryRow = {
  id: string;
  vehicle_id: number;
  dealer_id: string;
  document_type: "addendum" | "infosheet" | "buyer_guide";
  printed_by: string;
  template_id: string | null;
  pdf_url: string | null;
  created_at: string;
};

type PrintHistoryInsert = {
  vehicle_id: number;
  dealer_id: string;
  document_type: "addendum" | "infosheet" | "buyer_guide";
  printed_by: string;
  template_id?: string | null;
  pdf_url?: string | null;
};

export type AddendumLibraryRow = {
  id: string;
  dealer_id: string;
  option_name: string;
  item_price: string;
  description: string;
  ad_type: string;
  makes: string;
  makes_not: boolean;
  models: string;
  models_not: boolean;
  trims: string;
  trims_not: boolean;
  body_styles: string;
  year_condition: number;
  year_value: number | null;
  miles_condition: number;
  miles_value: number | null;
  msrp_condition: number;
  msrp1: number | null;
  msrp2: number | null;
  sort_order: number;
  active: boolean;
  show_models_only: boolean;
  separator_above: boolean;
  separator_below: boolean;
  spaces: number;
  created_at: string;
  updated_at: string;
};

type AddendumLibraryInsert = Omit<AddendumLibraryRow, 'id' | 'created_at' | 'updated_at'>;
type AddendumLibraryUpdate = Partial<Omit<AddendumLibraryRow, 'id' | 'dealer_id' | 'created_at' | 'updated_at'>>;

type AiContentCacheInsert = {
  vin: string;
  dealer_id: string;
  description?: string | null;
  features?: [string, string][] | null;
  generated_at?: string;
  model_version?: string | null;
};

type AiContentCacheUpdate = {
  description?: string | null;
  features?: [string, string][] | null;
  generated_at?: string;
  model_version?: string | null;
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
      groups: {
        Row: GroupRow;
        Insert: GroupInsert;
        Update: GroupUpdate;
        Relationships: [];
      };
      dealers: {
        Row: DealerRow;
        Insert: DealerInsert;
        Update: DealerUpdate;
        Relationships: [
          {
            foreignKeyName: "dealers_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          }
        ];
      };
      templates: {
        Row: TemplateRow;
        Insert: TemplateInsert;
        Update: TemplateUpdate;
        Relationships: [
          {
            foreignKeyName: "templates_dealer_id_fkey";
            columns: ["dealer_id"];
            isOneToOne: false;
            referencedRelation: "dealers";
            referencedColumns: ["dealer_id"];
          }
        ];
      };
      dealer_settings: {
        Row: DealerSettingsRow;
        Insert: DealerSettingsInsert;
        Update: DealerSettingsUpdate;
        Relationships: [
          {
            foreignKeyName: "dealer_settings_dealer_id_fkey";
            columns: ["dealer_id"];
            isOneToOne: true;
            referencedRelation: "dealers";
            referencedColumns: ["dealer_id"];
          }
        ];
      };
      ai_content_cache: {
        Row: AiContentCacheRow;
        Insert: AiContentCacheInsert;
        Update: AiContentCacheUpdate;
        Relationships: [];
      };
      vehicle_options: {
        Row: VehicleOptionRow;
        Insert: VehicleOptionInsert;
        Update: VehicleOptionUpdate;
        Relationships: [
          {
            foreignKeyName: "vehicle_options_dealer_id_fkey";
            columns: ["dealer_id"];
            isOneToOne: false;
            referencedRelation: "dealers";
            referencedColumns: ["dealer_id"];
          }
        ];
      };
      print_history: {
        Row: PrintHistoryRow;
        Insert: PrintHistoryInsert;
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: "print_history_dealer_id_fkey";
            columns: ["dealer_id"];
            isOneToOne: false;
            referencedRelation: "dealers";
            referencedColumns: ["dealer_id"];
          }
        ];
      };
      addendum_library: {
        Row: AddendumLibraryRow;
        Insert: AddendumLibraryInsert;
        Update: AddendumLibraryUpdate;
        Relationships: [
          {
            foreignKeyName: "addendum_library_dealer_id_fkey";
            columns: ["dealer_id"];
            isOneToOne: false;
            referencedRelation: "dealers";
            referencedColumns: ["dealer_id"];
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
