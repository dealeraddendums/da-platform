export type PaperSize = 'standard' | 'narrow' | 'infosheet';

export interface CustomSize {
  id: string;
  dealer_id: string;
  name: string;
  width_in: number;
  height_in: number;
  background_url: string | null;
}

export type WidgetType =
  | 'logo' | 'vehicle' | 'msrp' | 'options' | 'subtotal'
  | 'askbar' | 'dealer' | 'infobox' | 'headerbar' | 'customtext'
  | 'sigline' | 'description' | 'features' | 'barcode' | 'qrcode' | 'custom';

export interface OptionItem {
  name: string;
  desc: string;
  price: string;
}

export interface Widget {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  d: Record<string, unknown>;
}

export interface CustomWidgetDef {
  id: string;
  name: string;
  desc: string;
  scope: string;
  category: string;
  defaultW: number;
  defaultH: number;
  contentType: 'html' | 'image';
  html: string;
  variables: string[];
}

export interface VehiclePreload {
  id: string;
  vin: string;
  stock_number: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  color_ext: string | null;
  mileage: number | null;
  msrp: number | null;
  internet_price: number | null;
  dealer_id: string | null;
  logo_url?: string | null;
  dealer_name?: string | null;
  dealer_address?: string | null;
}

export interface SavedTemplate {
  id: string;
  name: string;
  document_type: 'addendum' | 'infosheet';
  vehicle_types: string[];
  template_json: Record<string, unknown>;
  is_active: boolean;
  updated_at: string;
}
