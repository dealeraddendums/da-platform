import { formatOptionPrice } from './option-price';

type AnyOption = { option_name: string; option_price: string };

interface VehicleFields {
  DESCRIPTION?: string | null;
  YEAR?: string | null;
  MAKE?: string | null;
  MODEL?: string | null;
  TRIM?: string | null;
  VIN_NUMBER?: string | null;
  STOCK_NUMBER?: string | null;
  MILEAGE?: string | null;
  EXT_COLOR?: string | null;
  MSRP?: string | null;
}

type AiContent = { description: string; features: [string, string][] } | null;

export function resolveCustomTextTokens(
  text: string,
  vehicle: VehicleFields,
  options: AnyOption[],
  aiContent: AiContent
): string {
  if (!text.includes('{{')) return text;

  const msrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : null;
  const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
  const total = (msrp ?? 0) + optTotal;

  const tokens: Record<string, string> = {
    'vehicle.description': vehicle.DESCRIPTION ?? '',
    'vehicle.year':        vehicle.YEAR ?? '',
    'vehicle.make':        vehicle.MAKE ?? '',
    'vehicle.model':       vehicle.MODEL ?? '',
    'vehicle.trim':        vehicle.TRIM ?? '',
    'vehicle.vin':         vehicle.VIN_NUMBER ?? '',
    'vehicle.stock':       vehicle.STOCK_NUMBER ?? '',
    'vehicle.mileage':     vehicle.MILEAGE ?? '',
    'vehicle.color':       vehicle.EXT_COLOR ?? '',
    'vehicle.msrp':        msrp != null ? `$${msrp.toLocaleString()}` : '',
    'vehicle.asking_price': total > 0 ? `$${total.toLocaleString()}` : '',
    'vehicle.options':     options
      .map(o => `${o.option_name}  ${formatOptionPrice(o.option_price)}`)
      .join('\n'),
    'ai.description': aiContent?.description ?? '',
    'ai.features':    aiContent?.features
      ? aiContent.features.map(([k, v]) => `${k}: ${v}`).join('\n')
      : '',
  };

  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => tokens[key.trim()] ?? '');
}
