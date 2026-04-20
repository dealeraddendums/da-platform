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
  legacy_id: number | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  billing_id: string | null;
  template_id: string | null;
  group_fee: string | null;
  billing_contact: string | null;
  billing_email: string | null;
  billing_phone: string | null;
  billing_address: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_country: string | null;
  billing_date: string | null;
  hubspot_company_id: string | null;
  feed_supplier: string | null;
  created_at: string;
  updated_at: string;
};

type GroupInsert = {
  name: string;
  active?: boolean;
  account_type?: string;
  internal_id?: string | null;
  legacy_id?: number | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  billing_id?: string | null;
  template_id?: string | null;
  group_fee?: string | null;
  billing_contact?: string | null;
  billing_email?: string | null;
  billing_phone?: string | null;
  billing_address?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  billing_country?: string | null;
  billing_date?: string | null;
  hubspot_company_id?: string | null;
  feed_supplier?: string | null;
  created_at?: string | null;
};

export type GroupUpdate = {
  name?: string;
  active?: boolean;
  account_type?: string;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  billing_id?: string | null;
  template_id?: string | null;
  group_fee?: string | null;
  billing_contact?: string | null;
  billing_email?: string | null;
  billing_phone?: string | null;
  billing_address?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  billing_country?: string | null;
  billing_date?: string | null;
  hubspot_company_id?: string | null;
  feed_supplier?: string | null;
};

export type DealerRow = {
  id: string;
  dealer_id: string;
  /** Never-changing billing ID (_ID). Used by da-billing for lineItemDescription. Never update. */
  internal_id: string | null;
  /** Inventory supplier-assigned ID. Matches Aurora DEALER_ID for inventory queries. */
  inventory_dealer_id: string | null;
  legacy_id: number | null;
  name: string;
  active: boolean;
  account_type: string;
  group_id: string | null;
  dealer_group_legacy: string | null;
  billing_id: string | null;
  template_id: string | null;
  feed_source: string | null;
  etl_job: string | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  billing_street: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_country: string | null;
  sub_billing_to: string | null;
  billing_to: string | null;
  referred_by: string | null;
  make1: string | null;
  make2: string | null;
  make3: string | null;
  make4: string | null;
  make5: string | null;
  lat: string | null;
  lng: string | null;
  hubspot_company_id: string | null;
  agent_name: string | null;
  email_report: number | null;
  report_send_to: string | null;
  last30: number | null;
  makes: string[];
  created_at: string;
  updated_at: string;
};

type DealerInsert = {
  dealer_id: string;
  name: string;
  internal_id?: string | null;
  inventory_dealer_id?: string | null;
  legacy_id?: number | null;
  active?: boolean;
  account_type?: string;
  group_id?: string | null;
  dealer_group_legacy?: string | null;
  billing_id?: string | null;
  template_id?: string | null;
  feed_source?: string | null;
  etl_job?: string | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  billing_street?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  billing_country?: string | null;
  sub_billing_to?: string | null;
  billing_to?: string | null;
  referred_by?: string | null;
  make1?: string | null;
  make2?: string | null;
  make3?: string | null;
  make4?: string | null;
  make5?: string | null;
  lat?: string | null;
  lng?: string | null;
  hubspot_company_id?: string | null;
  agent_name?: string | null;
  email_report?: number | null;
  report_send_to?: string | null;
  last30?: number | null;
  makes?: string[];
  created_at?: string | null;
};

export type DealerUpdate = {
  name?: string;
  /** inventory_dealer_id can be updated by super_admin when feed goes live. internal_id must never be updated. */
  inventory_dealer_id?: string | null;
  active?: boolean;
  account_type?: string;
  group_id?: string | null;
  dealer_group_legacy?: string | null;
  billing_id?: string | null;
  template_id?: string | null;
  feed_source?: string | null;
  etl_job?: string | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string;
  billing_street?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  billing_country?: string | null;
  sub_billing_to?: string | null;
  billing_to?: string | null;
  referred_by?: string | null;
  make1?: string | null;
  make2?: string | null;
  make3?: string | null;
  make4?: string | null;
  make5?: string | null;
  lat?: string | null;
  lng?: string | null;
  hubspot_company_id?: string | null;
  agent_name?: string | null;
  email_report?: number | null;
  report_send_to?: string | null;
  last30?: number | null;
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
  description: string | null;
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
  description?: string | null;
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
  ad_types: string[] | null;
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
  applies_to: "all" | "rules" | "none";
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

export type AddendumHistoryRow = {
  id: string;
  legacy_id: number | null;
  vehicle_id: number | null;
  vin: string | null;
  dealer_id: string | null;
  item_name: string;
  item_description: string | null;
  item_price: string | null;
  active: string | null;
  creation_date: string | null;
  separator_above: number | null;
  separator_below: number | null;
  separator_spaces: number | null;
  order_by: number | null;
  editable: number | null;
  source: string | null;
  imported_at: string;
  created_at: string | null;
  updated_at: string | null;
};

export type AddendumHistoryInsert = {
  item_name: string;
  legacy_id?: number | null;
  vehicle_id?: number | null;
  vin?: string | null;
  dealer_id?: string | null;
  item_description?: string | null;
  item_price?: string | null;
  active?: string | null;
  creation_date?: string | null;
  separator_above?: number | null;
  separator_below?: number | null;
  separator_spaces?: number | null;
  order_by?: number | null;
  editable?: number | null;
  source?: string | null;
  imported_at?: string;
  created_at?: string | null;
  updated_at?: string | null;
};

export type AdminSettingsRow = {
  key: string;
  value: string | null;
  updated_at: string;
};

export type AdminAuditRow = {
  id: string;
  admin_user_id: string;
  action: string;
  target_dealer_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type AdminAuditInsert = {
  admin_user_id: string;
  action: string;
  target_dealer_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

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

export type GroupOptionRow = {
  id: string;
  group_id: string;
  option_name: string;
  option_price: string;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type GroupOptionInsert = {
  group_id: string;
  option_name: string;
  option_price?: string;
  sort_order?: number;
  active?: boolean;
};

type GroupOptionUpdate = {
  option_name?: string;
  option_price?: string;
  sort_order?: number;
  active?: boolean;
  updated_at?: string;
};

export type GroupDisclaimerRow = {
  id: string;
  group_id: string;
  state_code: string;
  document_type: string;
  disclaimer_text: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type GroupDisclaimerInsert = {
  group_id: string;
  state_code?: string;
  document_type?: string;
  disclaimer_text: string;
  active?: boolean;
};

type GroupDisclaimerUpdate = {
  state_code?: string;
  document_type?: string;
  disclaimer_text?: string;
  active?: boolean;
  updated_at?: string;
};

export type GroupTemplateRow = {
  id: string;
  group_id: string;
  name: string;
  document_type: 'addendum' | 'infosheet';
  vehicle_types: string[];
  template_json: Record<string, unknown>;
  is_locked: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type GroupTemplateInsert = {
  group_id: string;
  name: string;
  document_type: 'addendum' | 'infosheet';
  vehicle_types?: string[];
  template_json?: Record<string, unknown>;
  is_locked?: boolean;
  is_active?: boolean;
};

type GroupTemplateUpdate = {
  name?: string;
  document_type?: 'addendum' | 'infosheet';
  vehicle_types?: string[];
  template_json?: Record<string, unknown>;
  is_locked?: boolean;
  is_active?: boolean;
  updated_at?: string;
};

export type DealerVehicleRow = {
  id: string;
  dealer_id: string;
  stock_number: string;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  body_style: string | null;
  exterior_color: string | null;
  interior_color: string | null;
  engine: string | null;
  transmission: string | null;
  drivetrain: string | null;
  mileage: number;
  msrp: number | null;
  condition: string;
  status: string;
  decode_source: string | null;
  decode_flagged: boolean;
  description: string | null;
  options: string | null;
  created_by: string | null;
  date_added: string;
  updated_at: string;
  // Extended fields matching legacy dealer_inventory schema (migration 020)
  doors: string | null;
  fuel: string | null;
  photos: string | null;
  date_in_stock: string | null;
  vdp_link: string | null;
  status_code: string | null;
  warranty_expires: string | null;
  insp_numb: string | null;
  msrp_adjustment: string | null;
  discounted_price: string | null;
  internet_price: string | null;
  cdjr_price: string | null;
  certified: string | null;
  hmpg: string | null;
  cmpg: string | null;
  mpg: string | null;
  print_status: number | null;
  print_date: string | null;
  print_guide: number | null;
  print_info: number | null;
  print_queue: number | null;
  print_user: string | null;
  print_flag: number | null;
  print_sms: number | null;
  options_added: number | null;
  re_order: number | null;
  edit_status: number | null;
  edit_date: string | null;
  input_date: string | null;
};

export type DealerVehicleInsert = {
  dealer_id: string;
  stock_number: string;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  body_style?: string | null;
  exterior_color?: string | null;
  interior_color?: string | null;
  engine?: string | null;
  transmission?: string | null;
  drivetrain?: string | null;
  mileage?: number;
  msrp?: number | null;
  condition?: string;
  status?: string;
  decode_source?: string | null;
  decode_flagged?: boolean;
  description?: string | null;
  options?: string | null;
  created_by?: string | null;
  // Extended fields (migration 020)
  doors?: string | null;
  fuel?: string | null;
  photos?: string | null;
  date_in_stock?: string | null;
  vdp_link?: string | null;
  status_code?: string | null;
  warranty_expires?: string | null;
  insp_numb?: string | null;
  msrp_adjustment?: string | null;
  discounted_price?: string | null;
  internet_price?: string | null;
  cdjr_price?: string | null;
  certified?: string | null;
  hmpg?: string | null;
  cmpg?: string | null;
  mpg?: string | null;
  print_status?: number | null;
  print_date?: string | null;
  print_guide?: number | null;
  print_info?: number | null;
  print_queue?: number | null;
  print_user?: string | null;
  print_flag?: number | null;
  print_sms?: number | null;
  options_added?: number | null;
  re_order?: number | null;
  edit_status?: number | null;
  edit_date?: string | null;
  input_date?: string | null;
};

export type VehicleAuditLogRow = {
  id: string;
  dealer_id: string;
  vehicle_id: string | null;
  stock_number: string | null;
  action: "import" | "edit" | "print" | "delete";
  method: string | null;
  changed_by: string | null;
  changed_by_email: string | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  document_type: string | null;
  created_at: string;
};

export type VehicleAuditLogInsert = {
  dealer_id: string;
  vehicle_id?: string | null;
  stock_number?: string | null;
  action: "import" | "edit" | "print" | "delete";
  method?: string | null;
  changed_by?: string | null;
  changed_by_email?: string | null;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  document_type?: string | null;
};

export type NhtsaOverrideRow = {
  id: string;
  vin_prefix: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  body_style: string | null;
  engine: string | null;
  transmission: string | null;
  drivetrain: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NhtsaSyncLogRow = {
  id: string;
  synced_at: string;
  records_imported: number | null;
  source_url: string | null;
  status: string | null;
  notes: string | null;
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
      addendum_history: {
        Row: AddendumHistoryRow;
        Insert: AddendumHistoryInsert;
        Update: Partial<Omit<AddendumHistoryRow, 'id'>>;
        Relationships: [];
      };
      admin_settings: {
        Row: AdminSettingsRow;
        Insert: { key: string; value?: string | null; updated_at?: string };
        Update: { value?: string | null; updated_at?: string };
        Relationships: [];
      };
      admin_audit: {
        Row: AdminAuditRow;
        Insert: AdminAuditInsert;
        Update: Record<string, never>;
        Relationships: [];
      };
      group_options: {
        Row: GroupOptionRow;
        Insert: GroupOptionInsert;
        Update: GroupOptionUpdate;
        Relationships: [];
      };
      group_disclaimers: {
        Row: GroupDisclaimerRow;
        Insert: GroupDisclaimerInsert;
        Update: GroupDisclaimerUpdate;
        Relationships: [];
      };
      group_templates: {
        Row: GroupTemplateRow;
        Insert: GroupTemplateInsert;
        Update: GroupTemplateUpdate;
        Relationships: [];
      };
      dealer_vehicles: {
        Row: DealerVehicleRow;
        Insert: DealerVehicleInsert;
        Update: Partial<Omit<DealerVehicleRow, 'id' | 'dealer_id' | 'date_added'>>;
        Relationships: [];
      };
      vehicle_audit_log: {
        Row: VehicleAuditLogRow;
        Insert: VehicleAuditLogInsert;
        Update: Record<string, never>;
        Relationships: [];
      };
      nhtsa_overrides: {
        Row: NhtsaOverrideRow;
        Insert: Omit<NhtsaOverrideRow, 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Omit<NhtsaOverrideRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      nhtsa_sync_log: {
        Row: NhtsaSyncLogRow;
        Insert: { records_imported?: number | null; source_url?: string | null; status?: string | null; notes?: string | null };
        Update: { status?: string | null; notes?: string | null; records_imported?: number | null };
        Relationships: [];
      };
      nhtsa_makes: {
        Row: { id: number; name: string; created_at: string };
        Insert: { id: number; name: string };
        Update: { name?: string };
        Relationships: [];
      };
      nhtsa_models: {
        Row: { id: number; make_id: number | null; name: string; vehicle_type_id: number | null };
        Insert: { id: number; make_id?: number | null; name: string; vehicle_type_id?: number | null };
        Update: { name?: string };
        Relationships: [];
      };
      nhtsa_wmi: {
        Row: { wmi: string; make_id: number | null; manufacturer_name: string | null; country: string | null };
        Insert: { wmi: string; make_id?: number | null; manufacturer_name?: string | null; country?: string | null };
        Update: { make_id?: number | null; manufacturer_name?: string | null; country?: string | null };
        Relationships: [];
      };
      nhtsa_trims: {
        Row: { id: number; model_id: number | null; name: string | null };
        Insert: { id: number; model_id?: number | null; name?: string | null };
        Update: { name?: string | null };
        Relationships: [];
      };
      nhtsa_vehicle_types: {
        Row: { id: number; name: string };
        Insert: { id: number; name: string };
        Update: { name?: string };
        Relationships: [];
      };
      nhtsa_body_styles: {
        Row: { id: number; name: string };
        Insert: { id: number; name: string };
        Update: { name?: string };
        Relationships: [];
      };
      nhtsa_vin_patterns: {
        Row: {
          id: string; pattern: string; make_id: number | null; model_id: number | null;
          trim_id: number | null; body_style_id: number | null; vehicle_type_id: number | null;
          model_year: number | null; engine: string | null; displacement: string | null;
          cylinders: string | null; fuel_type: string | null; transmission: string | null;
          drivetrain: string | null; doors: number | null; created_at: string;
        };
        Insert: {
          pattern: string; make_id?: number | null; model_id?: number | null;
          trim_id?: number | null; body_style_id?: number | null; vehicle_type_id?: number | null;
          model_year?: number | null; engine?: string | null; displacement?: string | null;
          cylinders?: string | null; fuel_type?: string | null; transmission?: string | null;
          drivetrain?: string | null; doors?: number | null;
        };
        Update: Record<string, unknown>;
        Relationships: [];
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
