'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SNAP, MIN_W, MIN_H, BG_DEFAULT, IS_BG_DEFAULT, IB_DEFAULT,
  PAPERS, LAYOUT, LAYOUT_INFOSHEET, WIDGET_LABELS, UNIQUE_WIDGETS,
  PALETTE_HIDDEN_IN_ADDENDUM, PALETTE_HIDDEN_IN_INFOSHEET,
  DEFS, DEFAULT_CUSTOM_WIDGETS, snapV, makeWidget,
} from './constants';
import { renderW } from './widgetRenderer';
import type { Widget, PaperSize, CustomWidgetDef, VehiclePreload, SavedTemplate } from './types';

// ── Palette widget tiles ──────────────────────────────────────────────
const PALETTE_TILES = [
  { type: 'logo',       emoji: '🏷️', label: 'Logo',           hint: 'Dealer brand',     group: 'content' },
  { type: 'vehicle',    emoji: '🚗', label: 'Vehicle data',   hint: 'Stock, VIN, Year…', group: 'content' },
  { type: 'msrp',       emoji: '💲', label: 'MSRP line',      hint: 'Label + price',     group: 'content', addendum: true },
  { type: 'options',    emoji: '📋', label: 'Options table',  hint: 'Dealer adds',       group: 'content', addendum: true },
  { type: 'subtotal',   emoji: 'Σ',  label: 'Subtotal',       hint: 'Options total',     group: 'content', addendum: true },
  { type: 'askbar',     emoji: '$',  label: 'Asking price',   hint: 'Total asking price',group: 'content' },
  { type: 'dealer',     emoji: '🏠', label: 'Dealer address', hint: 'Contact info',      group: 'content' },
  { type: 'description',emoji: '📝', label: 'Description',    hint: 'DB or AI text',     group: 'infosheet' },
  { type: 'features',   emoji: '✦',  label: 'Features list',  hint: '2-col DB or AI',    group: 'infosheet' },
  { type: 'barcode',    emoji: '▐▌', label: 'Barcode',        hint: 'VIN Code-128',      group: 'infosheet' },
  { type: 'qrcode',     emoji: '⊞',  label: 'QR Code',        hint: 'Vehicle page link', group: 'infosheet' },
  { type: 'headerbar',  emoji: '⬛', label: 'Header bar',     hint: 'Full-width text',   group: 'structural' },
  { type: 'customtext', emoji: 'T',  label: 'Custom text',    hint: 'Free content',      group: 'structural' },
  { type: 'sigline',    emoji: '✎',  label: 'Signature line', hint: 'Buyer + date',      group: 'structural' },
  { type: 'infobox',    emoji: '📦', label: 'Infobox',        hint: 'EPA, QR, photo…',   group: 'infobox', addendum: true },
];

const BG_COLORS = [
  ['#111','01 Black'], ['#1e3a5f','02 Blue'], ['#7f1d1d','03 Red'],
  ['#14532d','04 Green'], ['#4c1d95','05 Purple'], ['#0f172a','06 Navy'],
  ['#78350f','07 Gold'], ['#6b7280','08 Silver'], ['#374151','09 Charcoal'],
  ['#134e4a','10 Teal'], ['#4a1942','11 Maroon'], ['#1e3a8a','12 Cobalt'],
];

interface Props {
  vehicle?: VehiclePreload;
  templateId?: string;
  aiEnabled?: boolean;
}

export default function BuilderPage({ vehicle, templateId, aiEnabled = false }: Props) {
  const [widgets, setWidgets] = useState<Record<string, Widget>>({});
  const [nid, setNid] = useState(1);
  const [selId, setSelId] = useState<string | null>(null);
  const [Z, setZ] = useState(0.75);
  const [paperSize, setPaperSize] = useState<PaperSize>('standard');
  const [fontScale, setFontScale] = useState(1.0);
  const [bgUrl, setBgUrl] = useState(BG_DEFAULT);
  const [bgInputVal, setBgInputVal] = useState(BG_DEFAULT);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiPendingLoad, setAiPendingLoad] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [templateName, setTemplateName] = useState('New Template');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [toast, setToast] = useState<string | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
  const [customWidgets, setCustomWidgets] = useState<CustomWidgetDef[]>(DEFAULT_CUSTOM_WIDGETS);
  const [saveVtypes, setSaveVtypes] = useState<Set<string>>(new Set(['new']));
  const [saveTname, setSaveTname] = useState('');
  const [nudge, setNudge] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const [printAiOverride, setPrintAiOverride] = useState<'db'|'ai'|'default'>('default');

  // Refs for drag
  const paperRef = useRef<HTMLDivElement>(null);
  const widgetsRef = useRef<Record<string, Widget>>({});
  const widgetEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<{
    mode: 'move' | 'resize'; id: string; dir?: string;
    ox: number; oy: number; sx: number; sy: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);
  const ZRef = useRef(Z);
  const paperSizeRef = useRef(paperSize);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
  useEffect(() => { ZRef.current = Z; }, [Z]);
  useEffect(() => { paperSizeRef.current = paperSize; }, [paperSize]);

  // ── Toast ──────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  // ── History ────────────────────────────────────────────────────────
  const pushHistory = useCallback((ws: Record<string, Widget>, n: number) => {
    const snap = JSON.stringify({ widgets: ws, nid: n });
    setHistory(prev => {
      const next = prev.slice(0, histIdx + 1);
      next.push(snap);
      setHistIdx(next.length - 1);
      return next;
    });
  }, [histIdx]);

  const undo = useCallback(() => {
    if (histIdx <= 0) { showToast('Nothing to undo'); return; }
    const state = JSON.parse(history[histIdx - 1]);
    setWidgets(state.widgets);
    setNid(state.nid);
    setSelId(null);
    setHistIdx(h => h - 1);
  }, [histIdx, history, showToast]);

  const redo = useCallback(() => {
    if (histIdx >= history.length - 1) { showToast('Nothing to redo'); return; }
    const state = JSON.parse(history[histIdx + 1]);
    setWidgets(state.widgets);
    setNid(state.nid);
    setSelId(null);
    setHistIdx(h => h + 1);
  }, [histIdx, history, showToast]);

  // ── Add widget ─────────────────────────────────────────────────────
  const addWidget = useCallback((
    type: string, x?: number, y?: number, w?: number, h?: number, silent = false
  ) => {
    const isInfosheet = paperSizeRef.current === 'infosheet';
    if (UNIQUE_WIDGETS.includes(type) && Object.values(widgetsRef.current).some(wg => wg.type === type as Widget['type'])) {
      showToast('Widget already on canvas — only one per template');
      return;
    }
    const id = 'w' + nid;
    const widget = makeWidget(type, id, x, y, w, h, isInfosheet);
    setNid(n => n + 1);
    setWidgets(prev => {
      const next = { ...prev, [id]: widget };
      widgetsRef.current = next;
      if (!silent) pushHistory(next, nid + 1);
      return next;
    });
    if (!silent) setSelId(id);
  }, [nid, showToast, pushHistory]);

  // ── Delete widget ──────────────────────────────────────────────────
  const deleteWidget = useCallback((id: string) => {
    setWidgets(prev => {
      const next = { ...prev };
      delete next[id];
      widgetsRef.current = next;
      pushHistory(next, nid);
      return next;
    });
    setSelId(s => s === id ? null : s);
  }, [nid, pushHistory]);

  // ── Update widget data field ───────────────────────────────────────
  const updateWidget = useCallback((id: string, key: string, value: unknown) => {
    setWidgets(prev => {
      const w = prev[id]; if (!w) return prev;
      const next = { ...prev, [id]: { ...w, d: { ...w.d, [key]: value } } };
      widgetsRef.current = next;
      return next;
    });
  }, []);

  const updateWidgetPos = useCallback((id: string, key: 'x'|'y'|'w'|'h', value: number) => {
    if (isNaN(value)) return;
    setWidgets(prev => {
      const w = prev[id]; if (!w) return prev;
      const next = { ...prev, [id]: { ...w, [key]: snapV(value) } };
      widgetsRef.current = next;
      return next;
    });
  }, []);

  const adjFont = useCallback((id: string, key: string, delta: number) => {
    setWidgets(prev => {
      const w = prev[id]; if (!w) return prev;
      const cur = (w.d[key] as number) || 1.0;
      const val = Math.round(Math.max(0.5, Math.min(3.0, cur + delta)) * 10) / 10;
      const next = { ...prev, [id]: { ...w, d: { ...w.d, [key]: val } } };
      widgetsRef.current = next;
      return next;
    });
  }, []);

  // ── Drag/resize ────────────────────────────────────────────────────
  const startMove = useCallback((e: React.MouseEvent, id: string) => {
    if (previewMode) return;
    e.preventDefault();
    e.stopPropagation();
    setSelId(id);
    const w = widgetsRef.current[id];
    if (!w || !paperRef.current) return;
    const pr = paperRef.current.getBoundingClientRect();
    dragRef.current = {
      mode: 'move', id,
      ox: e.clientX - pr.left - w.x * ZRef.current,
      oy: e.clientY - pr.top  - w.y * ZRef.current,
      sx: e.clientX, sy: e.clientY,
      origX: w.x, origY: w.y, origW: w.w, origH: w.h,
    };
  }, [previewMode]);

  const startResize = useCallback((e: React.MouseEvent, id: string, dir: string) => {
    if (previewMode) return;
    e.preventDefault();
    e.stopPropagation();
    const w = widgetsRef.current[id];
    if (!w) return;
    dragRef.current = {
      mode: 'resize', id, dir,
      ox: 0, oy: 0,
      sx: e.clientX, sy: e.clientY,
      origX: w.x, origY: w.y, origW: w.w, origH: w.h,
    };
  }, [previewMode]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || !paperRef.current) return;
      const w = widgetsRef.current[drag.id];
      if (!w) return;
      const Z = ZRef.current;
      const ps = paperSizeRef.current;
      const pr = paperRef.current.getBoundingClientRect();
      const { w: pw, h: ph } = PAPERS[ps];
      let nx = w.x, ny = w.y, nw = w.w, nh = w.h;

      if (drag.mode === 'move') {
        nx = snapV(Math.max(0, Math.min(pw - w.w, (e.clientX - pr.left - drag.ox) / Z)));
        ny = snapV(Math.max(0, Math.min(ph - w.h, (e.clientY - pr.top  - drag.oy) / Z)));
      } else {
        const dx = (e.clientX - drag.sx) / Z;
        const dy = (e.clientY - drag.sy) / Z;
        const dir = drag.dir || '';
        nw = drag.origW; nh = drag.origH; nx = drag.origX; ny = drag.origY;
        if (dir.includes('e')) nw = snapV(Math.max(MIN_W, drag.origW + dx));
        if (dir.includes('s')) nh = snapV(Math.max(MIN_H, drag.origH + dy));
        if (dir.includes('w')) { nw = snapV(Math.max(MIN_W, drag.origW - dx)); nx = snapV(drag.origX + drag.origW - nw); }
        if (dir.includes('n')) { nh = snapV(Math.max(MIN_H, drag.origH - dy)); ny = snapV(drag.origY + drag.origH - nh); }
      }

      const updated = { ...w, x: nx, y: ny, w: nw, h: nh };
      widgetsRef.current = { ...widgetsRef.current, [drag.id]: updated };

      // Update DOM directly for smooth 60fps
      const el = widgetEls.current.get(drag.id);
      if (el) {
        el.style.left = nx + 'px'; el.style.top = ny + 'px';
        el.style.width = nw + 'px'; el.style.height = nh + 'px';
      }
    };

    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setWidgets({ ...widgetsRef.current });
      const ws = widgetsRef.current;
      setNid(n => { pushHistory(ws, n); return n; });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [pushHistory]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId) deleteWidget(selId);
      if (e.key === 'Escape') setSelId(null);
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey)) ) { e.preventDefault(); redo(); }
      if (selId && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.metaKey || e.ctrlKey ? 10 : e.shiftKey ? 4 : 1;
        setWidgets(prev => {
          const w = prev[selId]; if (!w) return prev;
          const { w: pw, h: ph } = PAPERS[paperSizeRef.current];
          let { x, y } = w;
          if (e.key === 'ArrowLeft')  x = Math.max(0, x - step);
          if (e.key === 'ArrowRight') x = Math.min(pw - w.w, x + step);
          if (e.key === 'ArrowUp')    y = Math.max(0, y - step);
          if (e.key === 'ArrowDown')  y = Math.min(ph - w.h, y + step);
          const next = { ...prev, [selId]: { ...w, x, y } };
          widgetsRef.current = next;
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selId, deleteWidget, undo, redo]);

  // ── Init default layout ────────────────────────────────────────────
  useEffect(() => {
    const order = ['logo','vehicle','msrp','options','subtotal','askbar','dealer','infobox'];
    let nextNid = 1;
    const ws: Record<string, Widget> = {};
    order.forEach(type => {
      const id = 'w' + nextNid++;
      ws[id] = makeWidget(type, id);
    });
    if (vehicle) {
      // Pre-fill vehicle data
      Object.values(ws).forEach(w => {
        if (w.type === 'vehicle') {
          w.d = {
            ...w.d,
            fields: ['stock','vin','year','color','make','trim','model'],
          };
        }
        if (w.type === 'dealer' && vehicle.dealer_name) {
          w.d = { ...w.d, text: [vehicle.dealer_name, vehicle.dealer_address || ''].filter(Boolean).join('\n') };
        }
        if (w.type === 'logo' && vehicle.logo_url) {
          w.d = { ...w.d, imgUrl: vehicle.logo_url };
        }
        if (w.type === 'msrp' && vehicle.msrp) {
          w.d = { ...w.d, value: `$${vehicle.msrp.toLocaleString()}` };
        }
        if (w.type === 'askbar' && vehicle.internet_price) {
          w.d = { ...w.d, value: `$${vehicle.internet_price.toLocaleString()}` };
        }
      });
    }
    widgetsRef.current = ws;
    setWidgets(ws);
    setNid(nextNid);
    pushHistory(ws, nextNid);
    if (vehicle) setTemplateName(`${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'New Template');
    // Load dealer settings (nudge margins)
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(data => {
      if (data) setNudge({ left: data.nudge_left || 0, right: data.nudge_right || 0, top: data.nudge_top || 0, bottom: data.nudge_bottom || 0 });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load template if templateId provided
  useEffect(() => {
    if (!templateId) return;
    fetch(`/api/templates/${templateId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const json = data.template_json as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: PaperSize };
        if (json.widgets) {
          setWidgets(json.widgets);
          widgetsRef.current = json.widgets;
        }
        if (json.nid) setNid(json.nid);
        if (json.bgUrl) { setBgUrl(json.bgUrl); setBgInputVal(json.bgUrl); }
        if (json.fontScale) setFontScale(json.fontScale);
        if (json.paperSize) setPaperSize(json.paperSize);
        setTemplateName(data.name || 'Template');
      })
      .catch(() => {});
  }, [templateId]);

  // ── Paper size switch ──────────────────────────────────────────────
  const switchPaperSize = useCallback((size: PaperSize) => {
    setPaperSize(size);
    paperSizeRef.current = size;
    if (size === 'infosheet') {
      setBgUrl(IS_BG_DEFAULT); setBgInputVal(IS_BG_DEFAULT);
      // Load infosheet default layout
      const order = ['logo','vehicle','description','features','askbar','qrcode','barcode','dealer','customtext'];
      let nextNid = 1;
      const ws: Record<string, Widget> = {};
      order.forEach(type => {
        const def = LAYOUT_INFOSHEET[type];
        if (!def) return;
        const id = 'w' + nextNid++;
        ws[id] = makeWidget(type, id, def.x, def.y, def.w, def.h, true);
        // Infosheet font overrides
        if (type === 'askbar') { ws[id].d = { ...ws[id].d, labelFontSize: 1.6, valueFontSize: 1.9 }; }
        if (type === 'vehicle') { ws[id].d = { ...ws[id].d, headerFontSize: 1.2 }; }
      });
      widgetsRef.current = ws;
      setWidgets(ws);
      setNid(nextNid);
      setSelId(null);
      pushHistory(ws, nextNid);
      showToast('Infosheet layout loaded');
      // Auto-load AI content when switching to infosheet with a vehicle
      if (vehicle && aiEnabled) {
        setAiPendingLoad(true);
      }
    } else {
      setBgUrl(BG_DEFAULT); setBgInputVal(BG_DEFAULT);
      const order = ['logo','vehicle','msrp','options','subtotal','askbar','dealer','infobox'];
      let nextNid = 1;
      const ws: Record<string, Widget> = {};
      order.forEach(type => {
        const id = 'w' + nextNid++;
        ws[id] = makeWidget(type, id);
      });
      widgetsRef.current = ws;
      setWidgets(ws);
      setNid(nextNid);
      setSelId(null);
      pushHistory(ws, nextNid);
    }
  }, [pushHistory, showToast, vehicle, aiEnabled]);

  // ── Drag from palette ──────────────────────────────────────────────
  const [dragType, setDragType] = useState<string | null>(null);
  const onDropCanvas = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!dragType || !paperRef.current) return;
    const pr = paperRef.current.getBoundingClientRect();
    const x = snapV(Math.max(0, (e.clientX - pr.left) / ZRef.current - 40));
    const y = snapV(Math.max(0, (e.clientY - pr.top)  / ZRef.current - 20));
    addWidget(dragType, x, y);
    setDragType(null);
  }, [dragType, addWidget]);

  // ── Alignment ──────────────────────────────────────────────────────
  const align = useCallback((dir: 'left'|'center'|'right') => {
    if (!selId) return;
    const w = widgetsRef.current[selId]; if (!w) return;
    const pw = PAPERS[paperSizeRef.current].w;
    let x = w.x;
    if (dir === 'left') x = 12;
    else if (dir === 'right') x = pw - w.w - 12;
    else x = snapV((pw - w.w) / 2);
    setWidgets(prev => {
      const next = { ...prev, [selId]: { ...w, x } };
      widgetsRef.current = next;
      return next;
    });
  }, [selId]);

  // ── AI content fetch / regenerate ─────────────────────────────────
  const fetchAiContent = useCallback(async (force = false) => {
    if (!vehicle?.vin || !vehicle?.dealer_id) return;
    setAiLoading(true);
    try {
      let data: { description?: string | null; features?: [string, string][] | null } | null = null;
      if (force) {
        const r = await fetch('/api/ai-content/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vin: vehicle.vin, dealer_id: vehicle.dealer_id }),
        });
        if (r.ok) data = await r.json();
      } else {
        const r = await fetch(`/api/ai-content?vin=${encodeURIComponent(vehicle.vin)}&dealer_id=${encodeURIComponent(vehicle.dealer_id)}`);
        if (r.ok) data = await r.json();
      }
      if (!data?.description && !data?.features) {
        if (force) showToast('AI generation failed — check API key');
        return;
      }
      setWidgets(prev => {
        const next = { ...prev };
        Object.values(next).forEach(w => {
          if (w.type === 'description' && data!.description) {
            next[w.id] = { ...w, d: { ...w.d, text: data!.description, aiMode: 'ai' } };
          }
          if (w.type === 'features' && data!.features?.length) {
            next[w.id] = { ...w, d: { ...w.d, items: data!.features, aiMode: 'ai' } };
          }
        });
        widgetsRef.current = next;
        return next;
      });
      showToast(force ? '✓ AI content regenerated' : '✓ AI content loaded');
    } catch {
      if (force) showToast('AI generation failed');
    } finally {
      setAiLoading(false);
    }
  }, [vehicle, showToast]);

  // Trigger AI load after infosheet layout is committed to state
  useEffect(() => {
    if (!aiPendingLoad) return;
    setAiPendingLoad(false);
    fetchAiContent(false);
  }, [aiPendingLoad, fetchAiContent]);

  // ── PDF download ───────────────────────────────────────────────────
  const downloadPdf = useCallback(async () => {
    if (!vehicle?.id) { showToast('Open a vehicle to generate a PDF'); return; }
    setPdfLoading(true);
    try {
      const docType = paperSize === 'infosheet' ? 'infosheet' : 'addendum';
      const res = await fetch('/api/pdf/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: parseInt(vehicle.id, 10),
          widgets: Object.values(widgetsRef.current),
          paperSize,
          fontScale,
          bgUrl,
          docType,
        }),
      });
      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        showToast(json.error ?? 'PDF generation failed');
        return;
      }
      const a = document.createElement('a');
      a.href = json.url;
      a.download = `${vehicle.year ?? ''}_${vehicle.make ?? ''}_${vehicle.model ?? ''}_${vehicle.stock_number || vehicle.id}.pdf`.replace(/\s+/g, '_');
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast('PDF downloaded');
    } catch {
      showToast('PDF generation failed');
    } finally {
      setPdfLoading(false);
    }
  }, [vehicle, paperSize, fontScale, bgUrl, showToast]);

  // ── Save template ──────────────────────────────────────────────────
  const saveTemplate = useCallback(async () => {
    const name = saveTname.trim() || templateName;
    if (!name) return;
    const docType = paperSize === 'infosheet' ? 'infosheet' : 'addendum';
    const vtypes = Array.from(saveVtypes).filter(v => v !== 'draft');
    const body = {
      name,
      document_type: docType,
      vehicle_types: vtypes.length ? vtypes : ['new'],
      template_json: { widgets: widgetsRef.current, nid, bgUrl, fontScale, paperSize },
      is_active: !saveVtypes.has('draft'),
    };
    try {
      const r = await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) {
        setTemplateName(name);
        setShowSave(false);
        showToast(`✓ Template saved: ${name}`);
      } else {
        showToast('Save failed — try again');
      }
    } catch {
      showToast('Save failed — try again');
    }
  }, [saveTname, templateName, paperSize, saveVtypes, nid, bgUrl, fontScale, showToast]);

  // ── Load templates list ────────────────────────────────────────────
  const openTemplates = useCallback(async () => {
    try {
      const r = await fetch('/api/templates');
      if (r.ok) { setSavedTemplates(await r.json()); }
    } catch {}
    setShowOpenModal(true);
  }, []);

  const loadTemplate = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/templates/${id}`);
      if (!r.ok) return;
      const data = await r.json();
      const json = data.template_json as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: PaperSize };
      if (json.widgets) { setWidgets(json.widgets); widgetsRef.current = json.widgets; }
      if (json.nid) setNid(json.nid);
      if (json.bgUrl) { setBgUrl(json.bgUrl); setBgInputVal(json.bgUrl); }
      if (json.fontScale) setFontScale(json.fontScale);
      if (json.paperSize) { setPaperSize(json.paperSize); paperSizeRef.current = json.paperSize; }
      setTemplateName(data.name || 'Template');
      setSelId(null);
      setShowOpenModal(false);
      showToast(`Loaded: ${data.name}`);
    } catch {
      showToast('Failed to load template');
    }
  }, [showToast]);

  // ── Selected widget ────────────────────────────────────────────────
  const sel = selId ? widgets[selId] : null;

  // ── Zoom ───────────────────────────────────────────────────────────
  const doZoom = (d: number) => { setZ(z => { const next = Math.max(0.25, Math.min(2, z + d)); ZRef.current = next; return next; }); };

  // ────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────
  const ps = PAPERS[paperSize];
  const isInfosheet = paperSize === 'infosheet';
  const usedTypes = new Set(Object.values(widgets).map(w => w.type));

  return (
    <div style={{ fontFamily: "'Roboto', -apple-system, sans-serif", display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontSize: 13, background: '#3a6897', color: '#333' }}>

      {/* TOPBAR */}
      <div style={{ height: 50, background: '#2a2b3c', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="/dashboard" style={{ fontSize: 13, fontWeight: 600, color: '#fff', textDecoration: 'none' }}>
            Dealer<span style={{ color: '#ffa500' }}>Addendums</span>
          </a>
          <div style={{ width: 1, height: 20, background: '#e0e0e0', flexShrink: 0 }} />
          <input
            value={templateName}
            onChange={e => setTemplateName(e.target.value)}
            style={{ border: 'none', background: 'transparent', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.87)', outline: 'none', width: 210, padding: '4px 6px', borderRadius: 5 }}
            onFocus={e => (e.target.style.background = 'rgba(255,255,255,0.12)')}
            onBlur={e => (e.target.style.background = 'transparent')}
          />
          {/* Vehicle type badges */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: 2, gap: 2 }}>
            {['New','Used','CPO'].map(t => (
              <button key={t} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none', background: 'transparent', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', fontFamily: 'inherit' }}
                onClick={() => showToast('Vehicle type saved with template')}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {previewMode && (
            <span style={{ fontSize: 11, color: '#4caf50', display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', background: 'rgba(76,175,80,0.15)', borderRadius: 20 }}>
              ● Preview mode
            </span>
          )}
          <button onClick={() => setPreviewMode(p => !p)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 13px', borderRadius: 4, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.25)', background: previewMode ? '#1976d2' : 'rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'inherit' }}>
            {previewMode ? '✎ Edit' : '👁 Preview'}
          </button>
          {vehicle && (usedTypes.has('description') || usedTypes.has('features')) && (
            <button
              onClick={() => fetchAiContent(true)}
              disabled={aiLoading}
              style={{ ...tbBtn, background: aiLoading ? 'rgba(255,255,255,0.08)' : 'rgba(25,118,210,0.85)', borderColor: '#1976d2', opacity: aiLoading ? 0.6 : 1 }}
            >
              {aiLoading ? '⟳ Generating…' : '✦ Regenerate AI'}
            </button>
          )}
          <button onClick={() => setShowPrint(true)} style={tbBtn}>🖨 Print settings</button>
          <button onClick={openTemplates} style={tbBtn}>All templates</button>
          <button onClick={() => { setSaveTname(templateName); setShowSave(true); }} style={{ ...tbBtn, background: '#1976d2', borderColor: '#1976d2' }}>Save template</button>
          <button
            onClick={() => void downloadPdf()}
            disabled={pdfLoading}
            style={{ ...tbBtn, background: pdfLoading ? 'rgba(76,175,80,0.6)' : '#4caf50', borderColor: '#4caf50', opacity: pdfLoading ? 0.7 : 1 }}
          >{pdfLoading ? '⟳ Generating…' : '⬛ Print / PDF'}</button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* PALETTE */}
        {!previewMode && (
          <div style={{ width: 190, background: '#fff', borderRight: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid #e0e0e0' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.06em' }}>Widgets — drag to canvas</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px 20px' }}>
              {(['content','infosheet','structural','infobox'] as const).map(group => {
                const tiles = PALETTE_TILES.filter(t => t.group === group);
                if (!tiles.length) return null;
                return (
                  <div key={group}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 0 5px' }}>
                      {group === 'infosheet' ? 'Infosheet' : group === 'infobox' ? 'Infobox' : group === 'content' ? 'Content' : 'Structural'}
                    </div>
                    {tiles.map(tile => {
                      const hidden = isInfosheet
                        ? PALETTE_HIDDEN_IN_INFOSHEET.includes(tile.type)
                        : PALETTE_HIDDEN_IN_ADDENDUM.includes(tile.type);
                      if (hidden) return null;
                      const used = UNIQUE_WIDGETS.includes(tile.type) && usedTypes.has(tile.type as Widget['type']);
                      return (
                        <div
                          key={tile.type}
                          draggable={!used}
                          onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; setDragType(tile.type); }}
                          onClick={() => !used && addWidget(tile.type)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 7,
                            padding: '7px 8px', border: '1px solid #e0e0e0', borderRadius: 4,
                            marginBottom: 3, cursor: used ? 'default' : 'grab',
                            background: '#fff', opacity: used ? 0.22 : 1,
                            filter: used ? 'grayscale(1)' : 'none',
                            pointerEvents: used ? 'none' : 'auto',
                            transition: 'all .12s',
                          }}
                        >
                          <div style={{ width: 26, height: 26, borderRadius: 5, background: '#f0f4ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0 }}>{tile.emoji}</div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 500, color: '#333' }}>{tile.label}</div>
                            <div style={{ fontSize: 10, color: '#78828c', marginTop: 1 }}>{tile.hint}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CANVAS AREA */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Canvas bar */}
          {!previewMode && (
            <div style={{ height: 40, background: '#2a2b3c', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 8, flexShrink: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.85)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#4caf50' }} />Canvas
              </div>
              <Tb onClick={() => doZoom(-0.05)}>−</Tb>
              <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#333', padding: '3px 7px', background: 'rgba(255,255,255,0.9)', borderRadius: 4, border: '1px solid rgba(255,255,255,0.25)', minWidth: 40, textAlign: 'center' }}>
                {Math.round(Z * 100)}%
              </div>
              <Tb onClick={() => doZoom(0.05)}>+</Tb>
              <Tb onClick={() => { setZ(0.75); ZRef.current = 0.75; }}>⊙</Tb>
              <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.2)' }} />
              <Tb onClick={undo} title="Undo">↩</Tb>
              <Tb onClick={redo} title="Redo">↪</Tb>
              <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.2)' }} />
              <Tb onClick={() => align('left')} title="Align left">⇤</Tb>
              <Tb onClick={() => align('center')} title="Center">↔</Tb>
              <Tb onClick={() => align('right')} title="Align right">⇥</Tb>
              <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.2)' }} />
              <select value={paperSize} onChange={e => switchPaperSize(e.target.value as PaperSize)}
                style={{ padding: '4px 6px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, fontSize: 11, fontFamily: 'inherit', background: 'rgba(255,255,255,0.9)', color: '#333', cursor: 'pointer', outline: 'none' }}>
                <option value="narrow">3.125&quot; × 11&quot; Narrow</option>
                <option value="standard">4.25&quot; × 11&quot; Standard</option>
                <option value="infosheet">8.5&quot; × 11&quot; Infosheet</option>
              </select>
              <select value={fontScale} onChange={e => setFontScale(+e.target.value)}
                style={{ padding: '4px 6px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, fontSize: 11, fontFamily: 'inherit', background: 'rgba(255,255,255,0.9)', color: '#333', cursor: 'pointer', outline: 'none' }}>
                <option value="0.8">Font: Small</option>
                <option value="1.0">Font: Medium</option>
                <option value="1.2">Font: Large</option>
                <option value="1.4">Font: X-Large</option>
              </select>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginLeft: 'auto', paddingRight: 4 }}>Drag to reposition · Handles to resize</span>
            </div>
          )}

          {/* Canvas scroll */}
          <div
            style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '32px 24px', background: '#3a6897', cursor: previewMode ? 'default' : undefined }}
            onDragOver={e => e.preventDefault()}
            onDrop={onDropCanvas}
          >
            {/* Paper */}
            <div
              ref={paperRef}
              style={{
                position: 'relative',
                width: ps.w, height: ps.h,
                flexShrink: 0,
                transform: `scale(${Z})`,
                transformOrigin: 'top center',
                background: '#fff',
                boxShadow: '0 12px 48px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.1)',
                overflow: 'hidden',
              }}
              onClick={e => { if (e.target === paperRef.current || (e.target as HTMLElement).classList.contains('paper-frame')) setSelId(null); }}
            >
              {/* Background frame */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="paper-frame"
                src={bgUrl}
                alt="frame"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none', zIndex: 2, mixBlendMode: 'multiply', display: 'block' }}
              />
              {/* Widgets */}
              {Object.values(widgets).map(w => {
                const isSelected = selId === w.id && !previewMode;
                return (
                  <div
                    key={w.id}
                    ref={el => { if (el) widgetEls.current.set(w.id, el); else widgetEls.current.delete(w.id); }}
                    style={{ position: 'absolute', left: w.x, top: w.y, width: w.w, height: w.h, zIndex: 10, cursor: previewMode ? 'default' : 'move', userSelect: 'none' }}
                    onMouseDown={e => startMove(e, w.id)}
                    onClick={e => { e.stopPropagation(); if (!previewMode) setSelId(w.id); }}
                  >
                    {/* Selection overlay */}
                    {!previewMode && (
                      <div style={{
                        position: 'absolute', inset: -1,
                        border: isSelected ? '1.5px solid #1976d2' : '1.5px dashed rgba(37,99,235,.4)',
                        borderRadius: 2, zIndex: 5, pointerEvents: 'none',
                        opacity: isSelected ? 1 : 0,
                        boxShadow: isSelected ? '0 0 0 1px #1976d2' : 'none',
                        transition: 'border-color .12s',
                      }} />
                    )}
                    {/* Label */}
                    {isSelected && (
                      <div style={{ position: 'absolute', top: -16, left: 0, fontSize: 9, fontWeight: 600, color: '#1976d2', background: '#e3f2fd', padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap', zIndex: 6, border: '1px solid rgba(37,99,235,.2)' }}>
                        {WIDGET_LABELS[w.type] || w.type}
                      </div>
                    )}
                    {/* Delete */}
                    {isSelected && (
                      <div
                        style={{ position: 'absolute', top: -8, right: -8, width: 18, height: 18, background: '#ff5252', borderRadius: '50%', border: '2px solid #fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#fff', fontWeight: 700, zIndex: 6 }}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); deleteWidget(w.id); }}
                      >✕</div>
                    )}
                    {/* Resize handles */}
                    {isSelected && (['nw','n','ne','e','se','s','sw','w'] as const).map(dir => (
                      <div
                        key={dir}
                        data-resize="1"
                        style={{
                          position: 'absolute', width: 10, height: 10,
                          background: '#fff', border: '1.5px solid #1976d2', borderRadius: 2, zIndex: 7,
                          ...resizeHandlePos(dir),
                          cursor: dir + '-resize',
                        }}
                        onMouseDown={e => startResize(e, w.id, dir)}
                      />
                    ))}
                    {/* Content */}
                    <div
                      style={{ width: '100%', height: '100%', overflow: 'visible' }}
                      dangerouslySetInnerHTML={{ __html: renderW(w.type, w.d, fontScale) }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* EDIT PANEL */}
        {!previewMode && (
          <div style={{ width: 240, background: '#fff', borderLeft: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
            <div style={{ padding: '11px 13px 9px', borderBottom: '1px solid #e0e0e0', flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>
                {sel ? (WIDGET_LABELS[sel.type] || sel.type) : 'Canvas'}
              </div>
              <div style={{ fontSize: 11, color: '#78828c', marginTop: 1 }}>
                {sel ? `${Math.round(sel.x)}, ${Math.round(sel.y)} · ${Math.round(sel.w)}×${Math.round(sel.h)}` : 'Click any widget to edit'}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {/* Background panel */}
              <EpSection>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontSize: 10, fontWeight: 600, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em' }}
                  onClick={() => setBgOpen(o => !o)}>
                  Background image <span>{bgOpen ? '▼' : '▶'}</span>
                </div>
                {bgOpen && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: 6, marginBottom: 8 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', background: bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT ? '#e3f2fd' : '#fff', borderBottom: '1px solid #e0e0e0' }}
                        onClick={() => { const u = isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT; setBgUrl(u); setBgInputVal(u); }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT} alt="" style={{ width: 18, height: 30, objectFit: 'cover', borderRadius: 2, flexShrink: 0, border: '1px solid #e0e0e0' }} />
                        <span style={{ fontSize: 11, flex: 1, color: bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT ? '#1976d2' : '#333', fontWeight: bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT ? 600 : 400 }}>Default</span>
                        {(bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT) && <span style={{ color: '#1976d2', fontSize: 11, fontWeight: 700 }}>✓</span>}
                      </div>
                      {BG_COLORS.map(([color, name]) => (
                        <div key={color}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', background: bgUrl === color ? '#e3f2fd' : '#fff', borderBottom: '1px solid #e0e0e0' }}
                          onClick={() => { setBgUrl(color); showToast(`Background '${name}' — loads from S3 in production`); }}>
                          <div style={{ width: 18, height: 30, borderRadius: 2, background: color, flexShrink: 0, border: '1px solid rgba(0,0,0,.15)' }} />
                          <span style={{ fontSize: 11, flex: 1, color: '#333' }}>{name}</span>
                          {bgUrl === color && <span style={{ color: '#1976d2', fontSize: 11 }}>✓</span>}
                        </div>
                      ))}
                    </div>
                    <div style={{ marginBottom: 4, fontSize: 11, color: '#55595c' }}>Load from URL</div>
                    <input
                      value={bgInputVal}
                      onChange={e => setBgInputVal(e.target.value)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 11, marginBottom: 4, boxSizing: 'border-box' }}
                      placeholder="https://s3.amazonaws.com/…/bg.png"
                    />
                    <button onClick={() => { if (bgInputVal) setBgUrl(bgInputVal); }} style={{ width: '100%', padding: '6px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Load background</button>
                  </div>
                )}
              </EpSection>

              {/* Widget edit panel */}
              {sel ? (
                <WidgetEditPanel
                  widget={sel}
                  fontScale={fontScale}
                  onUpdate={updateWidget}
                  onAdjFont={adjFont}
                  onDelete={deleteWidget}
                  onUpdatePos={updateWidgetPos}
                />
              ) : (
                <EpSection>
                  <div style={{ padding: '20px 0', textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 8, opacity: .3 }}>□</div>
                    <div style={{ fontSize: 11, color: '#78828c', lineHeight: 1.6 }}>Click any widget to edit its properties. All widgets are freely positionable and resizable.</div>
                  </div>
                </EpSection>
              )}
            </div>
          </div>
        )}
      </div>

      {/* PRINT SETTINGS MODAL */}
      {showPrint && (
        <Modal onClose={() => setShowPrint(false)} title="Print Settings">
          <div style={{ background: '#f5f6f7', borderRadius: 6, padding: 16 }}>
            <ModalRow icon="ℹ" label="AI Content">
              <div style={{ display: 'flex', gap: 6 }}>
                {(['default','db','ai'] as const).map(v => (
                  <button key={v} onClick={() => setPrintAiOverride(v)}
                    style={{ flex: 1, padding: '5px', borderRadius: 4, border: `2px solid ${printAiOverride === v ? '#1976d2' : '#e0e0e0'}`, background: printAiOverride === v ? '#e3f2fd' : '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: printAiOverride === v ? '#1976d2' : '#55595c' }}>
                    {v === 'default' ? 'Default' : v === 'db' ? 'DB' : 'AI ✨'}
                  </button>
                ))}
              </div>
            </ModalRow>
            <ModalRow icon="⊞" label={<>Nudge Margins (px) <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#1976d2', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginLeft: 4 }} title="Fine-tune print alignment for your printer.">?</span></>}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {(['left','right','top','bottom'] as const).map(side => (
                  <div key={side} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#55595c', minWidth: 44, textTransform: 'capitalize' }}>{side}:</span>
                    <input type="number" value={nudge[side]}
                      onChange={e => setNudge(n => ({ ...n, [side]: +e.target.value }))}
                      style={{ width: 70, padding: '5px 8px', border: 'none', borderBottom: '1px solid #c0c0c0', fontSize: 14, fontFamily: 'monospace', background: 'transparent', outline: 'none', textAlign: 'center' }} />
                    <span style={{ fontSize: 12, color: '#78828c' }}>px</span>
                  </div>
                ))}
              </div>
            </ModalRow>
          </div>
          <div style={{ padding: '16px 24px', borderTop: '1px solid #e0e0e0', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button onClick={() => setShowPrint(false)} style={mfClose}>CLOSE</button>
            <button onClick={async () => {
              await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nudge_left: nudge.left, nudge_right: nudge.right, nudge_top: nudge.top, nudge_bottom: nudge.bottom }) });
              setShowPrint(false); showToast('Print settings saved');
            }} style={mfSave}>SAVE CHANGES</button>
            <button
              onClick={() => { setShowPrint(false); void downloadPdf(); }}
              disabled={pdfLoading}
              style={{ ...mfSave, background: pdfLoading ? 'rgba(76,175,80,0.6)' : '#4caf50', borderColor: '#4caf50' }}
            >{pdfLoading ? '⟳ Generating…' : 'Download PDF'}</button>
          </div>
        </Modal>
      )}

      {/* SAVE TEMPLATE MODAL */}
      {showSave && (
        <Modal onClose={() => setShowSave(false)} title="Save Template">
          <div style={{ padding: '24px' }}>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#55595c', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 6 }}>Template Name</label>
              <input value={saveTname} onChange={e => setSaveTname(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid #e0e0e0', borderRadius: 6, fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                placeholder="e.g. Subaru Standard, Used Cars — Black V5"
                autoFocus />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#55595c', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 8 }}>Apply to vehicle type</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[['new','New'],['used','Used'],['cpo','CPO'],['all','All'],['draft','Save for later (Draft)']].map(([v,l]) => {
                  const on = saveVtypes.has(v);
                  return (
                    <button key={v} onClick={() => {
                      setSaveVtypes(prev => {
                        const next = new Set(prev);
                        if (v === 'all' || v === 'draft') { next.clear(); next.add(v); }
                        else {
                          next.delete('all'); next.delete('draft');
                          if (next.has(v)) next.delete(v); else next.add(v);
                          if (next.size === 0) next.add('new');
                        }
                        return next;
                      });
                    }}
                    style={{ padding: '7px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `2px solid ${on ? '#1976d2' : '#e0e0e0'}`, background: on ? '#1976d2' : '#fff', color: on ? '#fff' : '#55595c', fontFamily: 'inherit' }}>
                      {l}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ background: '#f5f6f7', borderRadius: 6, padding: '12px 14px', fontSize: 12, color: '#55595c', lineHeight: 1.8 }}>
              <div><strong>Template:</strong> <span style={{ color: '#333' }}>{saveTname || templateName || '—'}</span></div>
              <div><strong>Widgets:</strong> <span style={{ color: '#333' }}>{Object.keys(widgets).length} widgets</span></div>
              <div><strong>Applies to:</strong> <span style={{ color: '#1976d2', fontWeight: 600 }}>{Array.from(saveVtypes).map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(', ')}</span></div>
            </div>
          </div>
          <div style={{ padding: '16px 24px', borderTop: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: '#78828c' }}>Templates saved per dealer</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={() => setShowSave(false)} style={mfClose}>Cancel</button>
              <button onClick={saveTemplate} style={mfSave}>Save Template</button>
            </div>
          </div>
        </Modal>
      )}

      {/* OPEN TEMPLATES MODAL */}
      {showOpenModal && (
        <Modal onClose={() => setShowOpenModal(false)} title="Open Template">
          <div style={{ padding: '16px 24px', maxHeight: 400, overflowY: 'auto' }}>
            {savedTemplates.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#78828c', padding: 24, fontSize: 13 }}>No saved templates yet.</div>
            ) : savedTemplates.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #e0e0e0' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#333' }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: '#78828c', marginTop: 2 }}>{t.document_type} · {t.vehicle_types?.join(', ')}</div>
                </div>
                <button onClick={() => loadTemplate(t.id)} style={{ padding: '5px 12px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Load</button>
              </div>
            ))}
          </div>
          <div style={{ padding: '16px 24px', borderTop: '1px solid #e0e0e0', display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => setShowOpenModal(false)} style={mfClose}>Close</button>
          </div>
        </Modal>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#fff', padding: '8px 16px', borderRadius: 20, fontSize: 12, zIndex: 9999, pointerEvents: 'none' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────────

function Tb({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} style={{ width: 26, height: 26, borderRadius: 4, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
      {children}
    </button>
  );
}

function EpSection({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '11px 13px', borderBottom: '1px solid #e0e0e0' }}>{children}</div>;
}

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 6, width: 520, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e0e0e0', background: '#2a2b3c' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{title}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalRow({ icon, label, children }: { icon: React.ReactNode; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '14px 0', borderBottom: '1px solid #e0e0e0' }}>
      <div style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0, color: '#78828c' }}>{icon}</div>
      <div style={{ fontSize: 14, color: '#55595c', minWidth: 140, display: 'flex', alignItems: 'center' }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── Widget Edit Panel ──────────────────────────────────────────────────
function WidgetEditPanel({ widget: w, fontScale, onUpdate, onAdjFont, onDelete, onUpdatePos }: {
  widget: Widget;
  fontScale: number;
  onUpdate: (id: string, key: string, value: unknown) => void;
  onAdjFont: (id: string, key: string, delta: number) => void;
  onDelete: (id: string) => void;
  onUpdatePos: (id: string, key: 'x'|'y'|'w'|'h', value: number) => void;
}) {
  const d = w.d;
  const u = (key: string, val: unknown) => onUpdate(w.id, key, val);
  const af = (key: string, delta: number) => onAdjFont(w.id, key, delta);
  const fp = (key: 'x'|'y'|'w'|'h', val: number) => onUpdatePos(w.id, key, val);

  return (
    <>
      {/* Position & size */}
      <EpSection>
        <Eps>Position &amp; Size</Eps>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
          {(['x','y','w','h'] as const).map(k => (
            <div key={k}>
              <div style={{ fontSize: 10, color: '#55595c', marginBottom: 3 }}>{k.toUpperCase()}</div>
              <input type="number" value={Math.round(w[k])} onChange={e => fp(k, +e.target.value)}
                style={{ width: '100%', padding: '4px 5px', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }} />
            </div>
          ))}
        </div>
      </EpSection>

      {/* Type-specific controls */}
      {w.type === 'logo' && (
        <EpSection>
          <Eps>Logo</Eps>
          <Fd label="Logo URL">
            <input className="fi" value={(d.imgUrl as string) || ''} onChange={e => u('imgUrl', e.target.value)} style={fiStyle} placeholder="https://…" />
          </Fd>
          <Fd label="Placeholder text">
            <input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} />
          </Fd>
        </EpSection>
      )}

      {w.type === 'vehicle' && (
        <EpSection>
          <Eps>Vehicle Fields</Eps>
          {['stock','vin','year','color','make','trim','model','mileage'].map(f => (
            <div key={f} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ fontSize: 11, color: '#55595c', textTransform: 'capitalize' }}>{f}</span>
              <TogSwitch checked={((d.fields as string[]) || []).includes(f)}
                onChange={checked => {
                  const fields = ((d.fields as string[]) || []);
                  u('fields', checked ? [...fields, f] : fields.filter(x => x !== f));
                }} />
            </div>
          ))}
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #e0e0e0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
              <span style={{ fontSize: 11, color: '#55595c' }}>Show header (Year Make Model)</span>
              <TogSwitch checked={d.showHeader !== false} onChange={v => u('showHeader', v)} />
            </div>
          </div>
          <FontStepper label="Header font size" fkey="headerFontSize" base={14} d={d} fontScale={fontScale} af={af} />
          <FontStepper label="Detail font size" fkey="fontSize" base={10} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'msrp' && (
        <EpSection>
          <Eps>MSRP Line</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontSize: 11, color: '#55595c' }}>Divider line below</span>
            <TogSwitch checked={d.divider !== false} onChange={v => u('divider', v)} />
          </div>
          <FontStepper label="Font size" fkey="fontSize" base={11} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'options' && (
        <EpSection>
          <Eps>Options Table</Eps>
          <Fd label="Section label"><input value={(d.sectionLabel as string) || ''} onChange={e => u('sectionLabel', e.target.value)} style={fiStyle} /></Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Option names and prices are set per vehicle in the addendum editor — not in the template.</div>
          <FontStepper label="Font size" fkey="fontSize" base={10.5} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'subtotal' && (
        <EpSection>
          <Eps>Subtotal</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <FontStepper label="Font size" fkey="fontSize" base={12} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'askbar' && (
        <EpSection>
          <Eps>Asking Price Bar</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Subtitle (optional)"><input value={(d.subtitle as string) || ''} onChange={e => u('subtitle', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Label color">
            <ColorPair value={(d.labelColor as string) || '#ffffff'} onChange={v => u('labelColor', v)} />
          </Fd>
          <Fd label="Price color">
            <ColorPair value={(d.valueColor as string) || '#000000'} onChange={v => u('valueColor', v)} />
          </Fd>
          <FontStepper label="Label font size" fkey="labelFontSize" base={12} d={d} fontScale={fontScale} af={af} />
          <FontStepper label="Price font size" fkey="valueFontSize" base={13} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'dealer' && (
        <EpSection>
          <Eps>Dealer Address</Eps>
          <textarea value={(d.text as string) || ''} onChange={e => u('text', e.target.value)} rows={5}
            style={{ ...fiStyle, resize: 'none', width: '100%', boxSizing: 'border-box' }} />
          <FontStepper label="Font size" fkey="fontSize" base={10} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'headerbar' && (
        <EpSection>
          <Eps>Header Bar</Eps>
          <Fd label="Text"><input value={(d.text as string) || ''} onChange={e => u('text', e.target.value)} style={fiStyle} /></Fd>
          <Eps style={{ marginTop: 8 }}>Color</Eps>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {[['#1a1916','Black'],['#374151','Slate'],['#2563EB','Blue'],['#DC2626','Red'],['#15803D','Green'],['#7C3AED','Purple'],['#D97706','Gold']].map(([c,n]) => (
              <div key={c} title={n} onClick={() => u('color', c)}
                style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer', border: `1.5px solid ${(d.color as string) === c ? '#1976d2' : 'transparent'}`, boxShadow: (d.color as string) === c ? '0 0 0 2px rgba(37,99,235,.2)' : 'none' }} />
            ))}
          </div>
        </EpSection>
      )}

      {w.type === 'customtext' && (
        <EpSection>
          <Eps>Custom Text</Eps>
          <textarea value={(d.text as string) || ''} onChange={e => u('text', e.target.value)} rows={3}
            style={{ ...fiStyle, resize: 'none', width: '100%', boxSizing: 'border-box' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            <Fd label="Alignment">
              <select value={(d.align as string) || 'left'} onChange={e => u('align', e.target.value)} style={{ ...fiStyle, width: '100%' }}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Fd>
            <Fd label="Font size">
              <input type="number" value={(d.fs as number) || 10} min={7} max={24} onChange={e => u('fs', +e.target.value)} style={fiStyle} />
            </Fd>
          </div>
        </EpSection>
      )}

      {w.type === 'sigline' && (
        <EpSection>
          <Eps>Signature Line</Eps>
          <Fd label="Left field"><input value={(d.l1 as string) || ''} onChange={e => u('l1', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Right field"><input value={(d.l2 as string) || ''} onChange={e => u('l2', e.target.value)} style={fiStyle} /></Fd>
        </EpSection>
      )}

      {w.type === 'infobox' && (
        <EpSection>
          <Eps>Infobox Type</Eps>
          {[['epa','EPA/DOT Fuel Economy'],['photo','Dynamic vehicle photo'],['qr','QR code'],['barcode','VIN barcode'],['upload','Upload custom']].map(([v,l]) => (
            <div key={v} onClick={() => { u('ibType', v); if (v === 'epa') u('imgUrl', IB_DEFAULT); else u('imgUrl', ''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: `1px solid ${(d.ibType as string) === v ? '#1976d2' : '#e0e0e0'}`, borderRadius: 6, cursor: 'pointer', marginBottom: 3, background: (d.ibType as string) === v ? '#e3f2fd' : '#fff' }}>
              <span style={{ fontSize: 11, fontWeight: (d.ibType as string) === v ? 600 : 500, color: (d.ibType as string) === v ? '#1976d2' : '#333' } as React.CSSProperties}>{l}</span>
            </div>
          ))}
          <Fd label="Or load from URL" style={{ marginTop: 8 }}>
            <input value={(d.imgUrl as string) || ''} onChange={e => u('imgUrl', e.target.value)} style={{ ...fiStyle, fontSize: 11 }} placeholder="https://…" />
          </Fd>
        </EpSection>
      )}

      {w.type === 'description' && (
        <EpSection>
          <Eps>Description</Eps>
          <AiSourceToggle value={(d.aiMode as string) || 'db'} onChange={v => u('aiMode', v)} />
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, padding: '4px 0' }}>
            {d.aiMode === 'ai' ? 'Claude generates description from vehicle data at print time.' : 'Description pulled from vehicle database.'}
          </div>
          <Fd label="Preview text">
            <textarea value={(d.text as string) || ''} onChange={e => u('text', e.target.value)} rows={4}
              style={{ ...fiStyle, resize: 'none', width: '100%', boxSizing: 'border-box', fontSize: 11 }} />
          </Fd>
          <FontStepper label="Font size" fkey="fontSize" base={10} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'features' && (
        <EpSection>
          <Eps>Features List</Eps>
          <AiSourceToggle value={(d.aiMode as string) || 'db'} onChange={v => u('aiMode', v)} />
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, padding: '4px 0' }}>
            {d.aiMode === 'ai' ? 'Claude generates features list at print time. Items shown are a preview.' : 'Features pulled from vehicle equipment database. 2-column layout auto-formatted.'}
          </div>
          <FontStepper label="Font size" fkey="fontSize" base={9} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {w.type === 'barcode' && (
        <EpSection>
          <Eps>Barcode</Eps>
          <Fd label="VIN (auto-populated at print time)">
            <input value={(d.vin as string) || ''} onChange={e => u('vin', e.target.value)} style={{ ...fiStyle, fontFamily: 'monospace', fontSize: 12 }} placeholder="VIN auto-filled from vehicle record" />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Code-128 barcode generated at print time via JsBarcode.</div>
        </EpSection>
      )}

      {w.type === 'qrcode' && (
        <EpSection>
          <Eps>QR Code</Eps>
          <Fd label="URL"><input value={(d.url as string) || ''} onChange={e => u('url', e.target.value)} style={{ ...fiStyle, fontSize: 11 }} placeholder="https://…" /></Fd>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>QR code links to vehicle detail page. URL auto-populated at print time.</div>
        </EpSection>
      )}

      {/* Delete button */}
      <EpSection>
        <button onClick={() => onDelete(w.id)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', borderRadius: 4, border: '1px solid #ffcdd2', background: '#ffebee', color: '#ff5252', fontSize: 11, fontWeight: 500, cursor: 'pointer', width: '100%', justifyContent: 'center', fontFamily: 'inherit' }}>
          ✕ Remove widget
        </button>
      </EpSection>
    </>
  );
}

// ── Edit Panel sub-components ─────────────────────────────────────────

function Eps({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 10, fontWeight: 600, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7, ...style }}>{children}</div>;
}

function Fd({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: 7, ...style }}>
      <div style={{ fontSize: 11, color: '#55595c', marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

function TogSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ position: 'relative', width: 30, height: 17, flexShrink: 0, cursor: 'pointer' }} onClick={() => onChange(!checked)}>
      <div style={{ position: 'absolute', inset: 0, background: checked ? '#1976d2' : '#c0c0c0', borderRadius: 20, transition: 'background .15s' }} />
      <div style={{ position: 'absolute', top: 2, left: checked ? 15 : 2, width: 13, height: 13, background: '#fff', borderRadius: '50%', transition: 'left .15s' }} />
    </div>
  );
}

function FontStepper({ label, fkey, base, d, fontScale, af }: {
  label: string; fkey: string; base: number;
  d: Record<string, unknown>; fontScale: number;
  af: (key: string, delta: number) => void;
}) {
  const val = (d[fkey] as number) || 1.0;
  const px = Math.round(base * fontScale * val);
  const pct = Math.round(val * 100);
  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #e0e0e0' }}>
      <div style={{ fontSize: 11, color: '#55595c', marginBottom: 4 }}>
        {label} <span style={{ fontFamily: 'monospace', color: '#1976d2' }}>{px}px</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => af(fkey, -0.1)} style={stepBtn}>−</button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#55595c' }}>{pct}% of global</div>
        <button onClick={() => af(fkey, 0.1)} style={stepBtn}>+</button>
      </div>
    </div>
  );
}

function ColorPair({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
      {[['#ffffff','White'],['#000000','Black']].map(([c,n]) => (
        <div key={c} onClick={() => onChange(c)} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <div style={{ width: 24, height: 24, background: c, border: `2px solid ${value === c ? '#2563EB' : '#ccc'}`, borderRadius: 3, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: '#55595c' }}>{n}</span>
        </div>
      ))}
    </div>
  );
}

function AiSourceToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
      {[['db','DB'],['ai','AI ✨']].map(([v,l]) => (
        <button key={v} onClick={() => onChange(v)}
          style={{ flex: 1, padding: 5, borderRadius: 4, border: `2px solid ${value === v ? '#1976d2' : '#e0e0e0'}`, background: value === v ? '#e3f2fd' : '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: value === v ? '#1976d2' : '#55595c' }}>
          {l}
        </button>
      ))}
    </div>
  );
}

// ── Resize handle positions ────────────────────────────────────────────
function resizeHandlePos(dir: string): React.CSSProperties {
  const m = { top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' };
  if (dir.includes('n')) m.top = '-5px'; else if (dir.includes('s')) m.bottom = '-5px'; else { m.top = 'calc(50% - 5px)'; }
  if (dir.includes('w')) m.left = '-5px'; else if (dir.includes('e')) m.right = '-5px'; else { m.left = 'calc(50% - 5px)'; }
  return m;
}

// ── Shared styles ──────────────────────────────────────────────────────
const fiStyle: React.CSSProperties = { width: '100%', padding: '5px 8px', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', color: '#333', background: '#fff', outline: 'none', boxSizing: 'border-box' };
const stepBtn: React.CSSProperties = { width: 28, height: 28, border: '1px solid #e0e0e0', borderRadius: 4, background: '#f5f6f7', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const tbBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 13px', borderRadius: 4, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.87)', fontFamily: 'inherit' };
const mfClose: React.CSSProperties = { padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', fontFamily: 'inherit', background: 'transparent', color: '#333' };
const mfSave: React.CSSProperties = { padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', fontFamily: 'inherit', background: '#4caf50', color: '#fff' };
