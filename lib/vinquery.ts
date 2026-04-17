// Server-only: VINQuery API client
// Set VINQUERY_API_KEY in .env.production — key currently on legacy EC2

export interface VinQueryData {
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  engine?: string;
  fuel?: string;
  drivetrain?: string;
  transmission?: string;
  bodyStyle?: string;
  doors?: string;
  cylinders?: string;
  displacement?: string;
  horsepower?: string;
  mpgCity?: string;
  mpgHighway?: string;
  country?: string;
  plantCity?: string;
}

function extractAttr(xml: string, name: string): string | undefined {
  // Handles both: name="X" value="Y" and value="Y" name="X" ordering
  const re = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
  const m = xml.match(re) ?? xml.match(re2);
  const val = m?.[1]?.trim();
  return val && val.length > 0 ? val : undefined;
}

export async function decodeVin(vin: string): Promise<VinQueryData | null> {
  const key = process.env.VINQUERY_API_KEY;
  if (!key) return null;

  try {
    const url =
      `https://www.vinquery.com/ws/vinquery.asmx/GetVINdata` +
      `?VIN=${encodeURIComponent(vin)}` +
      `&AccessCode=${encodeURIComponent(key)}` +
      `&PackageType=3`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'DAP/1.0' },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!xml.includes('<') || xml.toLowerCase().includes('error')) return null;

    return {
      year:         extractAttr(xml, 'Model Year'),
      make:         extractAttr(xml, 'Make'),
      model:        extractAttr(xml, 'Model'),
      trim:         extractAttr(xml, 'Trim Level') ?? extractAttr(xml, 'Trim'),
      engine:       extractAttr(xml, 'Engine') ?? extractAttr(xml, 'Engine Description'),
      fuel:         extractAttr(xml, 'Fuel Type') ?? extractAttr(xml, 'Fuel Type - Primary'),
      drivetrain:   extractAttr(xml, 'Drive Type') ?? extractAttr(xml, 'Drive'),
      transmission: extractAttr(xml, 'Transmission') ?? extractAttr(xml, 'Transmission Style'),
      bodyStyle:    extractAttr(xml, 'Body Style') ?? extractAttr(xml, 'Body Class'),
      doors:        extractAttr(xml, 'Doors') ?? extractAttr(xml, 'Number of Doors'),
      cylinders:    extractAttr(xml, 'Cylinders') ?? extractAttr(xml, 'Engine Number of Cylinders'),
      displacement: extractAttr(xml, 'Displacement') ?? extractAttr(xml, 'Displacement (L)'),
      horsepower:   extractAttr(xml, 'Horsepower') ?? extractAttr(xml, 'Engine Brake (hp)'),
      mpgCity:      extractAttr(xml, 'City MPG'),
      mpgHighway:   extractAttr(xml, 'Highway MPG'),
      country:      extractAttr(xml, 'Country of Assembly') ?? extractAttr(xml, 'Plant Country'),
      plantCity:    extractAttr(xml, 'Plant City'),
    };
  } catch {
    return null;
  }
}
