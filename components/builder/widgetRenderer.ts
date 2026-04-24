import { IB_DEFAULT } from './constants';

type D = Record<string, unknown>;

export function renderW(type: string, d: D, fontScale: number): string {
  const fs = fontScale;

  if (type === 'logo') {
    if (d.imgUrl === null) return '';  // dealer has no logo — render blank
    if (d.imgUrl)
      return `<img style="width:100%;height:100%;object-fit:contain;object-position:left center;display:block;" src="${d.imgUrl}" alt="Logo">`;
    return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-radius:4px;"><span style="font-size:16px;font-weight:700;color:#bbb;">${d.label || 'Your Logo'}</span></div>`;
  }

  if (type === 'vehicle') {
    const vd = (d.vehicleData as Record<string, string>) || { stock: 'STOCK_TEST1', vin: '2HGFC3B96HH362096', year: '2017', color: 'White', make: 'Honda', trim: 'Touring', model: 'Civic', mileage: '10' };
    const lb: Record<string, string> = { stock: 'Stock:', vin: 'VIN:', year: 'Year:', color: 'Color:', make: 'Make:', trim: 'Trim:', model: 'Model:', mileage: 'Mileage:' };
    const flds = (d.fields as string[]) || Object.keys(vd);
    const hdrFs = Math.round(13 * fs * ((d.headerFontSize as number) || 1));
    const detFs = Math.round(9 * fs * ((d.fontSize as number) || 1));
    const hdr = d.showHeader !== false
      ? `<div style="font-size:${hdrFs}px;font-weight:800;color:#1a1916;line-height:1.2;margin-bottom:3px;letter-spacing:-.01em">${vd.year} ${vd.make} ${vd.model} ${vd.trim}</div>`
      : '';
    const pairs: string[][] = [];
    for (let i = 0; i < flds.length; i += 2) pairs.push([flds[i], flds[i + 1]].filter(Boolean));
    const rows = pairs.map(p =>
      `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1px">${p.map(f =>
        `<div style="font-size:${detFs}px;color:#444">${lb[f] || f} <b style="color:#1a1916;font-weight:600">${(vd as Record<string,string>)[f] || ''}</b></div>`
      ).join('')}</div>`
    ).join('');
    return `<div style="padding:3px 0">${hdr}${rows}</div>`;
  }

  if (type === 'msrp') {
    const sz = Math.round(11 * fs * ((d.fontSize as number) || 1));
    return `<div style="padding:3px 0"><div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:${sz}px;font-weight:700;color:#1a1916">${d.label}</span><span style="font-size:${sz}px;font-weight:700;color:#1a1916;font-family:monospace">${d.value}</span></div>${d.divider !== false ? '<div style="height:1px;background:#1a1916;margin-top:3px"></div>' : ''}</div>`;
  }

  if (type === 'options') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const szm = Math.round(9 * fs * ((d.fontSize as number) || 1));
    const items = (d.items as Array<{name:string;desc:string;price:string}>) || [];
    return `<div style="padding:3px 0"><div style="font-size:${sz}px;color:#555;margin-bottom:4px">${d.sectionLabel}</div>${items.map(it =>
      `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:3px 0;border-bottom:1px solid #f0f0f0"><div><div style="font-size:${sz}px;font-weight:700;color:#333">${it.name}</div>${it.desc ? `<div style="font-size:${szm}px;color:#666;padding-left:8px;margin-top:1px;line-height:1.3">${it.desc}</div>` : ''}</div><div style="font-size:${sz}px;font-weight:700;color:#333;font-family:monospace;white-space:nowrap;padding-left:6px;flex-shrink:0">${it.price}</div></div>`
    ).join('')}</div>`;
  }

  if (type === 'subtotal') {
    const sz = Math.round(12 * fs * ((d.fontSize as number) || 1));
    return `<div style="padding:3px 0;display:flex;justify-content:flex-end;gap:12px"><span style="font-size:${sz}px;font-weight:700;color:#1a1916">${d.label}</span><span style="font-size:${sz}px;font-weight:700;color:#1a1916;font-family:monospace">${d.value}</span></div>`;
  }

  if (type === 'askbar') {
    const lfs = Math.round(12 * fs * ((d.labelFontSize as number) || 1));
    const vfs = Math.round(13 * fs * ((d.valueFontSize as number) || 1));
    const sfs = Math.round(8 * fs * ((d.labelFontSize as number) || 1));
    const lc = (d.labelColor as string) || '#ffffff';
    const vc = (d.valueColor as string) || '#000000';
    return `<div style="display:flex;justify-content:space-between;align-items:center;width:100%;height:100%;padding:0 4px"><div><div style="font-size:${lfs}px;font-weight:800;color:${lc};letter-spacing:-.01em">${d.label}</div>${d.subtitle ? `<div style="font-size:${sfs}px;color:${lc};font-style:italic;margin-top:1px">${d.subtitle}</div>` : ''}</div><div style="font-size:${vfs}px;font-weight:800;color:${vc};font-family:monospace;padding:2px 8px;border-radius:1px;min-width:110px;text-align:right">${d.value}</div></div>`;
  }

  if (type === 'dealer') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const ta = (d.textAlign as string) || 'left';
    const lh = (d.lineHeight as number) || 1.5;
    return `<div style="padding:4px 0"><div style="font-size:${sz}px;color:#1a1916;line-height:${lh};font-weight:700;text-align:${ta}">${((d.text as string) || '').replace(/\n/g, '<br>')}</div></div>`;
  }

  if (type === 'headerbar') {
    return `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:${d.color || '#1a1916'}"><div style="font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.06em">${d.text || 'HEADER'}</div></div>`;
  }

  if (type === 'customtext') {
    const ta = (d.textAlign as string) || (d.align as string) || 'left';
    const lh = (d.lineHeight as number) || 1.5;
    return `<div style="padding:4px 0"><div style="font-size:${d.fs || 10}px;text-align:${ta};color:#555;line-height:${lh}">${((d.text as string) || '').replace(/\n/g, '<br>')}</div></div>`;
  }

  if (type === 'sigline') {
    return `<div style="padding:6px 0;width:100%"><div style="display:flex;gap:12px"><div style="flex:1"><div style="border-bottom:1px solid #1a1916;height:18px;margin-bottom:2px"></div><div style="font-size:8px;color:#888">${d.l1 || 'Buyers Signature'}</div></div><div style="flex:1"><div style="border-bottom:1px solid #1a1916;height:18px;margin-bottom:2px"></div><div style="font-size:8px;color:#888">${d.l2 || 'Date'}</div></div></div></div>`;
  }

  if (type === 'infobox') {
    return `<div style="width:100%;height:100%"><img src="${(d.imgUrl as string) || IB_DEFAULT}" style="width:100%;height:100%;object-fit:fill;display:block;mix-blend-mode:multiply" alt="Infobox"></div>`;
  }

  if (type === 'description') {
    const sz = Math.round(10 * fs * ((d.fontSize as number) || 1));
    const badge = d.aiMode === 'ai'
      ? '<span style="font-size:8px;background:#e3f2fd;color:#1976d2;padding:1px 6px;border-radius:8px;font-weight:700;margin-left:5px">AI</span>'
      : '<span style="font-size:8px;background:#f0f0f0;color:#78828c;padding:1px 6px;border-radius:8px;font-weight:600;margin-left:5px">DB</span>';
    return `<div style="padding:3px 0;height:100%;box-sizing:border-box;overflow:hidden"><div style="font-size:8px;font-weight:700;color:#78828c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;display:flex;align-items:center">Description${badge}</div><div style="font-size:${sz}px;color:#222;line-height:1.6">${d.text || 'Vehicle description will appear here.'}</div></div>`;
  }

  if (type === 'features') {
    const sz = Math.round(9 * fs * ((d.fontSize as number) || 1));
    const badge = d.aiMode === 'ai'
      ? '<span style="font-size:8px;background:#e3f2fd;color:#1976d2;padding:1px 6px;border-radius:8px;font-weight:700;margin-left:5px">AI</span>'
      : '<span style="font-size:8px;background:#f0f0f0;color:#78828c;padding:1px 6px;border-radius:8px;font-weight:600;margin-left:5px">DB</span>';
    const items = (d.items as Array<[string, string]>) || [['Feature', 'Feature']];
    const rows = items.map(p =>
      `<div style="display:flex"><div style="flex:1;font-size:${sz}px;color:#1a1916;padding:1.5px 4px 1.5px 0;border-bottom:1px solid #ececec;line-height:1.4">${p[0] || ''}</div><div style="flex:1;font-size:${sz}px;color:#1a1916;padding:1.5px 0 1.5px 4px;border-bottom:1px solid #ececec;border-left:1px solid #ececec;line-height:1.4">${p[1] || ''}</div></div>`
    ).join('');
    return `<div style="padding:3px 0;height:100%;box-sizing:border-box;overflow:hidden"><div style="font-size:8px;font-weight:700;color:#78828c;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;display:flex;align-items:center">Features / Options${badge}</div><div style="border:1px solid #e0e0e0;border-radius:2px;overflow:hidden">${rows}</div></div>`;
  }

  if (type === 'barcode') {
    const vin = (d.vin as string) || '5TFDYS3F11MX956768';
    const seed = vin.split('').map(c => c.charCodeAt(0));
    let bars = '';
    for (let i = 0; i < 3; i++) bars += '<div style="display:inline-block;width:2px;height:52px;background:#000;margin-right:1px;vertical-align:top"></div>';
    seed.forEach(v => {
      const n = 1 + (v % 2), w2 = 2 + (v % 3), s = 1 + ((v * 7) % 2);
      bars += `<div style="display:inline-block;width:${n}px;height:52px;background:#000;margin-right:${s}px;vertical-align:top"></div>`;
      bars += `<div style="display:inline-block;width:${w2}px;height:52px;background:#000;margin-right:${s}px;vertical-align:top"></div>`;
    });
    for (let i = 0; i < 4; i++) bars += '<div style="display:inline-block;width:2px;height:52px;background:#000;margin-right:1px;vertical-align:top"></div>';
    return `<div style="text-align:center;padding:4px 2px;background:#fff;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center"><div style="line-height:0;padding:4px 6px;background:#fff;overflow:hidden">${bars}</div><div style="font-size:10px;font-family:monospace;margin-top:4px;letter-spacing:1px;color:#000">*${vin}*</div></div>`;
  }

  if (type === 'qrcode') {
    const url = encodeURIComponent((d.url as string) || 'https://dealeraddendums.com');
    const label = (d.label as string) || 'Scan for more info';
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:4px;background:#fff;box-sizing:border-box"><img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${url}&margin=2" style="width:calc(100% - 4px);height:calc(100% - 20px);object-fit:contain;display:block" alt="QR Code"><div style="font-size:9px;color:#555;margin-top:3px;text-align:center;font-weight:600">${label}</div></div>`;
  }

  if (type === 'custom') {
    return '<div style="padding:8px;color:#999;font-size:11px;height:100%;display:flex;align-items:center;justify-content:center">Custom widget</div>';
  }

  return '';
}
