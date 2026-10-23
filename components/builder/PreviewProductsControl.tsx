'use client';

// Template Builder — "Preview products": which products the canvas previews, so a dealer with many
// products can size the product widgets. PREVIEW ONLY — never changes what prints (the selection lives
// in templates.preview_products, which the print pipeline never reads).
//   All               every product that may apply to the previewed condition (today's behaviour)
//   Shown in Builder  a hand-picked set per condition (New / Used / CPO), saved on the template
//   As vehicle        a real stock #: exactly the products and prices that vehicle prints

import { useEffect, useMemo, useState } from 'react';
import { PREVIEW_CONDITIONS, type PreviewCondition, type PreviewSelection } from '@/lib/builder-preview';

export type CatalogItem = { key: string; name: string; price: string; conditions?: PreviewCondition[]; section: 'Required' | 'Suggested' };
type VehicleHit = { id: string; stock: string; label: string; condition: PreviewCondition };

const HELP = 'Preview only — choose which products the canvas shows so you can size the product boxes. Never changes what prints.';
const btn = (on = false): React.CSSProperties => ({
  padding: '3px 7px', fontSize: 11, fontWeight: 600, borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
  border: '1px solid rgba(255,255,255,0.25)', background: on ? '#ffa500' : 'transparent', color: on ? '#2a2b3c' : 'rgba(255,255,255,0.85)',
});

export default function PreviewProductsControl({ selection, onChange, catalog, condition, dealerId, saveNote }: {
  selection: PreviewSelection;
  onChange: (s: PreviewSelection) => void;
  catalog: CatalogItem[];
  condition: PreviewCondition;
  dealerId: string | null;
  /** Why the selection isn't saved (unsaved template / locked group template), shown in the picker. */
  saveNote: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const [vq, setVq] = useState('');
  const [hits, setHits] = useState<VehicleHit[]>([]);
  const [vOpen, setVOpen] = useState(false);

  useEffect(() => {
    if (!vOpen || !dealerId) return;
    const t = setTimeout(() => {
      fetch(`/api/builder/preview-vehicle?dealer_id=${encodeURIComponent(dealerId)}&q=${encodeURIComponent(vq.trim())}`)
        .then(r => (r.ok ? r.json() : { vehicles: [] })).then(j => setHits(j.vehicles ?? [])).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [vq, vOpen, dealerId]);

  const setMode = (mode: PreviewSelection['mode']) => {
    if (mode === 'picked' && selection.picked[condition].length === 0) setPicking(true);
    if (mode === 'vehicle' && !selection.vehicle) { setVOpen(true); return; }
    onChange({ ...selection, mode });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative', flexShrink: 0 }} title={HELP}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Products</span>
      <button type="button" style={btn(selection.mode === 'all')} onClick={() => setMode('all')}>All</button>
      <button type="button" style={btn(selection.mode === 'picked')} onClick={() => (selection.mode === 'picked' ? setPicking(true) : setMode('picked'))}
        title="Hand-pick the products the canvas shows (per New / Used / CPO)">
        Shown in Builder{selection.mode === 'picked' ? ` (${selection.picked[condition].length})` : ''}
      </button>
      <button type="button" style={btn(selection.mode === 'vehicle')} onClick={() => (selection.mode === 'vehicle' ? setVOpen(!vOpen) : setMode('vehicle'))}
        title="Preview exactly what one vehicle in your inventory prints">
        {selection.mode === 'vehicle' && selection.vehicle ? `As #${selection.vehicle.stock}` : 'As vehicle'}
      </button>

      {vOpen && (
        <div style={{ position: 'absolute', top: 30, left: 0, width: 320, background: '#fff', color: '#2a2b3c', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.3)', padding: 10, zIndex: 80 }}>
          <input autoFocus placeholder="Stock #, VIN or model…" value={vq} onChange={e => setVq(e.target.value)}
            style={{ width: '100%', height: 30, border: '1px solid #ccc', borderRadius: 4, padding: '0 8px', fontSize: 12 }} />
          <div style={{ maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>
            {hits.map(h => (
              <button key={h.id} type="button" onClick={() => { onChange({ ...selection, mode: 'vehicle', vehicle: { id: h.id, stock: h.stock } }); setVOpen(false); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 0, borderBottom: '1px solid #eee', background: 'none', cursor: 'pointer', fontSize: 12 }}>
                <strong>#{h.stock}</strong> · {h.condition} · {h.label}
              </button>
            ))}
            {!hits.length && <p style={{ margin: 6, fontSize: 12, color: '#78828c' }}>{dealerId ? 'No vehicles match.' : 'As vehicle needs a dealer (not available on group templates).'}</p>}
          </div>
        </div>
      )}

      {picking && (
        <PickModal catalog={catalog} selection={selection} startCondition={condition} saveNote={saveNote}
          onClose={() => setPicking(false)} onSave={(picked) => { onChange({ ...selection, mode: 'picked', picked }); setPicking(false); }} />
      )}
    </div>
  );
}

function PickModal({ catalog, selection, startCondition, saveNote, onClose, onSave }: {
  catalog: CatalogItem[]; selection: PreviewSelection; startCondition: PreviewCondition; saveNote: string | null;
  onClose: () => void; onSave: (picked: PreviewSelection['picked']) => void;
}) {
  const [cond, setCond] = useState<PreviewCondition>(startCondition);
  const [picked, setPicked] = useState(selection.picked);
  const [q, setQ] = useState('');
  const shown = useMemo(() => catalog.filter(c => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())), [catalog, q]);
  const set = new Set(picked[cond]);
  const toggle = (k: string) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k); else next.add(k);
    // Keep print order (catalog order) so the canvas stacks them as printing would.
    setPicked({ ...picked, [cond]: catalog.map(c => c.key).filter(x => next.has(x)) });
  };
  const all = (on: boolean) => {
    const next = new Set(set);
    for (const c of shown) { if (on) next.add(c.key); else next.delete(c.key); }
    setPicked({ ...picked, [cond]: catalog.map(c => c.key).filter(x => next.has(x)) });
  };
  return (
    <div role="dialog" aria-label="Products shown in Builder" onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 10, color: '#2a2b3c', boxShadow: '0 20px 60px rgba(0,0,0,.35)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #e5e5e5' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 15 }}>Products shown in Builder</strong>
            <button type="button" onClick={onClose} style={{ border: 0, background: 'none', fontSize: 18, cursor: 'pointer' }} aria-label="Close">×</button>
          </div>
          <p style={{ margin: '4px 0 10px', fontSize: 12, color: '#55595c' }}>{HELP} Each condition keeps its own set.</p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {PREVIEW_CONDITIONS.map(c => (
              <button key={c} type="button" onClick={() => setCond(c)}
                style={{ padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer', border: '1px solid #ccc', background: cond === c ? '#2a2b3c' : '#fff', color: cond === c ? '#fff' : '#2a2b3c' }}>
                {c} <span style={{ opacity: 0.7 }}>{picked[c].length}</span>
              </button>
            ))}
            <input placeholder="Search products…" value={q} onChange={e => setQ(e.target.value)}
              style={{ marginLeft: 'auto', height: 28, border: '1px solid #ccc', borderRadius: 4, padding: '0 8px', fontSize: 12, width: 180 }} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 12 }}>
            <button type="button" onClick={() => all(true)} style={{ border: 0, background: 'none', color: '#1565c0', cursor: 'pointer', padding: 0 }}>Select all</button>
            <button type="button" onClick={() => all(false)} style={{ border: 0, background: 'none', color: '#1565c0', cursor: 'pointer', padding: 0 }}>Select none</button>
            <span style={{ marginLeft: 'auto', color: '#78828c' }}>{picked[cond].length} of {catalog.length} for {cond}</span>
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr style={{ textAlign: 'left', color: '#78828c', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              <th style={{ padding: '6px 16px', width: 28 }} /><th>Product</th><th>Type</th><th>Applies to</th><th style={{ textAlign: 'right', paddingRight: 16 }}>Price</th>
            </tr></thead>
            <tbody>
              {shown.map(c => (
                <tr key={c.key} onClick={() => toggle(c.key)} style={{ borderTop: '1px solid #f0f0f0', cursor: 'pointer', background: set.has(c.key) ? '#fff8e1' : undefined }}>
                  <td style={{ padding: '6px 16px' }}><input type="checkbox" readOnly checked={set.has(c.key)} /></td>
                  <td style={{ padding: '6px 4px' }}>{c.name}</td>
                  <td style={{ color: '#55595c' }}>{c.section}</td>
                  <td style={{ color: (c.conditions ?? PREVIEW_CONDITIONS).includes(cond) ? '#55595c' : '#b26a00' }}
                    title={(c.conditions ?? PREVIEW_CONDITIONS).includes(cond) ? undefined : `Your product rules don't apply this to ${cond} vehicles`}>
                    {(c.conditions ?? PREVIEW_CONDITIONS).join(' / ')}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 16, whiteSpace: 'nowrap' }}>{c.price}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} style={{ padding: 16, color: '#78828c' }}>No products match.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid #e5e5e5', display: 'flex', alignItems: 'center', gap: 10 }}>
          {saveNote && <span style={{ fontSize: 12, color: '#b26a00' }}>{saveNote}</span>}
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', padding: '6px 14px', border: '1px solid #ccc', background: '#fff', borderRadius: 4, cursor: 'pointer' }}>Cancel</button>
          <button type="button" onClick={() => onSave(picked)} style={{ padding: '6px 14px', border: 0, background: '#ffa500', color: '#2a2b3c', fontWeight: 700, borderRadius: 4, cursor: 'pointer' }}>Show these</button>
        </div>
      </div>
    </div>
  );
}
