'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SNAP, MIN_W, MIN_H, BG_DEFAULT, IS_BG_DEFAULT, IB_DEFAULT,
  PAPERS, LAYOUT, LAYOUT_INFOSHEET, WIDGET_LABELS, UNIQUE_WIDGETS,
  PALETTE_HIDDEN_IN_ADDENDUM, PALETTE_HIDDEN_IN_INFOSHEET,
  DEFS, DEFAULT_CUSTOM_WIDGETS, snapV, makeWidget, getPaperDims,
  SAMPLE_SUGGESTED_ITEMS,
} from './constants';
import { renderW } from './widgetRenderer';
import RichTextEditor from '@/components/RichTextEditor';
import { WATERMARK_BRANDS, watermarkUrl } from '@/lib/watermarks';
import type { Widget, PaperSize, CustomWidgetDef, VehiclePreload, SavedTemplate, CustomSize } from './types';
import { useBuilderBreadcrumb } from '@/contexts/BuilderBreadcrumb';
import CustomSizesModal from '@/components/CustomSizesModal';
import AddCustomSizeModal from './AddCustomSizeModal';
import ImageUploadPicker from '@/components/ImageUploadPicker';
import ImagePickerModal from '@/components/ImagePickerModal';

// ── Palette widget tiles ──────────────────────────────────────────────
const PALETTE_TILES = [
  { type: 'logo',              emoji: '🏷️', label: 'Logo',              hint: 'Dealer brand',          group: 'content' },
  { type: 'vehicle',           emoji: '🚗', label: 'Vehicle data',      hint: 'Stock, VIN, Year…',     group: 'content' },
  { type: 'msrp',              emoji: '💲', label: 'MSRP line',         hint: 'Label + price',         group: 'content', addendum: true },
  { type: 'retail_wholesale',  emoji: '🔖', label: 'Retail/Wholesale',  hint: 'Struck-through retail + discount', group: 'content', addendum: true },
  { type: 'options',           emoji: '📋', label: 'Required Products',  hint: 'Dealer-installed items', group: 'content', addendum: true },
  { type: 'subtotal',          emoji: 'Σ',  label: 'Subtotal',          hint: 'Required options total', group: 'content', addendum: true },
  { type: 'askbar',            emoji: '$',  label: 'Asking price',      hint: 'MSRP + required',       group: 'content' },
  { type: 'dealer',            emoji: '🏠', label: 'Dealer address',    hint: 'Contact info',          group: 'content' },
  { type: 'description',       emoji: '📝', label: 'Description',       hint: 'Populated at print time', group: 'infosheet' },
  { type: 'features',          emoji: '✦',  label: 'Features list',     hint: 'Populated at print time', group: 'infosheet' },
  { type: 'mpg',               emoji: '⛽', label: 'MPG',               hint: 'City / Highway',         group: 'infosheet' },
  { type: 'headerbar',         emoji: '⬛', label: 'Header bar',        hint: 'Full-width text',       group: 'structural' },
  { type: 'customtext',        emoji: 'T',  label: 'Custom text',       hint: 'Free content',          group: 'structural' },
  { type: 'sigline',           emoji: '✎',  label: 'Signature line',    hint: 'Buyer + date',          group: 'structural' },
  { type: 'disclaimer',        emoji: '⚖️', label: 'Disclaimer',        hint: 'State or group disclaimer text', group: 'structural' },
  { type: 'divider',           emoji: '─',  label: 'Divider line',      hint: 'Horizontal rule',       group: 'structural' },
  // Dynamic content — independent, multi-instance widgets that replaced the
  // monolithic Infobox. Drop as many as needed; mix and match freely.
  { type: 'bgimage',           emoji: '🖼️', label: 'Custom Image',      hint: 'Full-width image',      group: 'dynamic' },
  { type: 'qrcode',            emoji: '⊞',  label: 'QR Code',           hint: 'Scan for more info',    group: 'dynamic' },
  { type: 'barcode',           emoji: '▐▌', label: 'VIN Barcode',       hint: 'Vehicle barcode',       group: 'dynamic' },
  { type: 'vehiclephoto',      emoji: '📷', label: 'Vehicle Photo',     hint: 'Color-matched photo',   group: 'dynamic' },
  { type: 'watermark',         emoji: '💧', label: 'Watermark',         hint: 'Faint brand logo',      group: 'dynamic' },
  { type: 'suggested_options', emoji: '💭', label: 'Suggested Products', hint: 'Optional buyer add-ons', group: 'suggested', addendum: true },
  { type: 'suggested_price',   emoji: '💰', label: 'Suggested Price',   hint: 'MSRP + all options',    group: 'suggested', addendum: true },
];


/**
 * Convert legacy `infobox` widgets to the new independent widget types.
 *   ibType=epa    → bgimage (EPA default already set on imgUrl)
 *   ibType=upload → bgimage (carries the uploaded custom URL)
 *   ibType=qr     → qrcode  (carries qrUrlTemplate + label/url)
 *   ibType=barcode→ barcode (carries vin)
 *   ibType=photo  → vehiclephoto (URL resolved at print time)
 *
 * Idempotent — only touches type==='infobox' rows. Logs a warning once per
 * legacy widget so we can spot un-saved templates in production traffic.
 */
function convertLegacyInfoboxes(ws: Record<string, Widget>): Record<string, Widget> {
  let changed = false;
  const result: Record<string, Widget> = {};
  for (const [id, w] of Object.entries(ws)) {
    if (w.type !== 'infobox') { result[id] = w; continue; }
    const ibType = (w.d.ibType as string) || 'epa';
    let newType: Widget['type'];
    let newD: Record<string, unknown>;
    switch (ibType) {
      case 'qr':
        newType = 'qrcode';
        newD = { url: w.d.url ?? 'https://dealeraddendums.com', qrUrlTemplate: w.d.qrUrlTemplate ?? null, label: w.d.label ?? 'Scan for more info', size: w.d.size ?? 120, imgUrl: w.d.imgUrl };
        break;
      case 'barcode':
        newType = 'barcode';
        newD = { vin: w.d.vin ?? '', stock: w.d.stock ?? '' };
        break;
      case 'photo':
        newType = 'vehiclephoto';
        newD = { angle: '03', imgUrl: w.d.imgUrl ?? '', label: 'Vehicle Photo' };
        break;
      case 'upload':
      case 'epa':
      default:
        newType = 'bgimage';
        newD = { imgUrl: w.d.imgUrl ?? '', label: 'Custom Image' };
        break;
    }
    result[id] = { ...w, type: newType, d: newD };
    changed = true;
    if (typeof console !== 'undefined') {
      console.warn(`[builder] converted legacy infobox widget ${id} (ibType=${ibType}) → ${newType}`);
    }
  }
  return changed ? result : ws;
}

// Resolve infosheet-ness from a paperSize string. Returns true for the
// built-in `'infosheet'` paper *or* a custom size whose `doc_type`
// is `'infosheet'`. Every call site that used to test
// `paperSize === 'infosheet'` should call this instead — palette
// hide list, background bucket, AI fetch gate, saveDocType default,
// picker bucket, bg-default click.
function resolveIsInfosheet(ps: string, sizes: CustomSize[]): boolean {
  if (ps === 'infosheet') return true;
  return sizes.find(c => c.id === ps)?.doc_type === 'infosheet';
}

// Nudge any widget whose top-left corner is outside canvas back to the nearest in-bounds position
function clampWidgets(ws: Record<string, Widget>, pw: number, ph: number): Record<string, Widget> {
  let changed = false;
  const result: Record<string, Widget> = {};
  for (const [id, w] of Object.entries(ws)) {
    const x = Math.max(0, Math.min(pw - MIN_W, w.x));
    const y = Math.max(0, Math.min(ph - MIN_H, w.y));
    if (x !== w.x || y !== w.y) { result[id] = { ...w, x, y }; changed = true; }
    else result[id] = w;
  }
  return changed ? result : ws;
}

// Asking-price (askbar) is OPTIONAL — the user can delete it from a template and
// it must STAY deleted. This previously re-added an askbar on every load if none
// was present, so a deleted asking-price kept reappearing. Now a pass-through:
// loading a saved template respects exactly what was saved. New/blank canvases
// still include an askbar via the default widget order in applyBlankCanvas.
function ensureAskbar(ws: Record<string, Widget>, nid: number, _ps: string): [Record<string, Widget>, number] {
  return [ws, nid];
}

// Override all logo widgets with the canonical dealer logo.
// logoUrl=null → imgUrl='' (shows "Upload logo in Settings" placeholder on canvas).
// Canvas always shows the live dealer logo; PDF rendering overrides independently via pdf-html.ts.
// Inject the resolved disclaimer list onto any Disclaimer widgets so canvas
// preview matches what pdf-html.ts will render at print time.
function applyDisclaimerToWidgets(
  ws: Record<string, Widget>,
  disclaimers: Array<{ text: string; locked?: boolean }>,
): Record<string, Widget> {
  const result: Record<string, Widget> = {};
  let changed = false;
  for (const [id, w] of Object.entries(ws)) {
    if (w.type === 'disclaimer') {
      result[id] = { ...w, d: { ...w.d, disclaimers } };
      changed = true;
    } else {
      result[id] = w;
    }
  }
  return changed ? result : ws;
}

// Fill the dealer's canonical logo URL into logo widgets ONLY when they
// don't already have one. A picked image (from the "Choose Logo Image"
// library dialog) is persisted on the widget as imgUrl and must win over
// the dealer's default logo_url, otherwise reloading a template wipes the
// selection. Without an explicit pick this falls back to the canonical
// dealer logo, so fresh templates and templates saved before the user
// picked anything still show something sensible — and a logo upload in
// Settings propagates to every template that hasn't been explicitly
// assigned a different image.
function applyLogoToWidgets(ws: Record<string, Widget>, logoUrl: string | null): Record<string, Widget> {
  const result: Record<string, Widget> = {};
  let changed = false;
  for (const [id, w] of Object.entries(ws)) {
    if (w.type === 'logo') {
      const existing = (w.d as { imgUrl?: unknown }).imgUrl;
      const hasExisting = typeof existing === 'string' && existing.length > 0;
      if (hasExisting) {
        result[id] = w;
      } else {
        result[id] = { ...w, d: { ...w.d, imgUrl: logoUrl ?? '' } };
        changed = true;
      }
    } else {
      result[id] = w;
    }
  }
  return changed ? result : ws;
}

// Apply dealer address to dealer widgets when no vehicle is available (blank builder).
function applyDealerInfoToWidgets(
  ws: Record<string, Widget>,
  info: DealerInfo,
): Record<string, Widget> {
  const cityStateZip = [info.city, info.state, info.zip].filter(Boolean).join(' ') || null;
  const lines = [info.name, info.address, cityStateZip, info.phone].filter(Boolean) as string[];
  if (!lines.length) return ws;
  const result: Record<string, Widget> = {};
  for (const [id, w] of Object.entries(ws)) {
    result[id] = w.type === 'dealer'
      ? { ...w, d: { ...w.d, text: lines.join('\n') } }
      : w;
  }
  return result;
}

// Populate widget d-data from real vehicle/dealer data — mirrors pdf-html.ts enrichment
function applyVehicleDataToWidgets(
  ws: Record<string, Widget>,
  vehicle: VehiclePreload,
): Record<string, Widget> {
  const result: Record<string, Widget> = {};
  for (const [id, w] of Object.entries(ws)) {
    if (w.type === 'vehicle') {
      result[id] = { ...w, d: { ...w.d, vehicleData: {
        stock: vehicle.stock_number ?? '',
        vin: vehicle.vin ?? '',
        year: vehicle.year ? String(vehicle.year) : '',
        color: vehicle.color_ext ?? '',
        make: vehicle.make ?? '',
        trim: vehicle.trim ?? '',
        model: vehicle.model ?? '',
        mileage: vehicle.mileage ? String(vehicle.mileage) : '',
      }}};
    } else if (w.type === 'barcode') {
      result[id] = { ...w, d: { ...w.d, vin: vehicle.vin ?? '' } };
    } else if (w.type === 'mpg') {
      result[id] = { ...w, d: { ...w.d, cmpg: vehicle.cmpg ?? null, hmpg: vehicle.hmpg ?? null } };
    } else if (w.type === 'dealer') {
      const lines = [
        vehicle.dealer_name,
        vehicle.dealer_address,
        [vehicle.dealer_city, vehicle.dealer_state, vehicle.dealer_zip].filter(Boolean).join(' '),
        vehicle.dealer_phone,
      ].filter(Boolean) as string[];
      result[id] = lines.length ? { ...w, d: { ...w.d, text: lines.join('\n') } } : w;
    } else if (w.type === 'msrp' && vehicle.msrp) {
      result[id] = { ...w, d: { ...w.d, value: vehicle.msrp.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) } };
    } else if (w.type === 'askbar' && vehicle.msrp) {
      result[id] = { ...w, d: { ...w.d, value: vehicle.msrp.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) } };
    } else if (w.type === 'qrcode' && vehicle.vdp_link) {
      result[id] = { ...w, d: { ...w.d, url: vehicle.vdp_link } };
    } else {
      result[id] = w;
    }
  }
  return result;
}

// Capture the pointer on the drag-origin element so pointerup/pointercancel are
// delivered even when released outside the paper or the window.
function capturePointer(e: React.PointerEvent): HTMLElement | null {
  const el = e.currentTarget as HTMLElement;
  try { el.setPointerCapture(e.pointerId); } catch { return null; }
  return el;
}

type DealerInfo = {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
};

interface Props {
  vehicle?: VehiclePreload;
  templateId?: string;
  aiEnabled?: boolean;
  customSizes?: CustomSize[];
  dealerId?: string;
  dealerLogoUrl?: string | null;
  dealerInfo?: DealerInfo;
  groupId?: string;
  canAddCustomSize?: boolean;
  /** Gates super_admin-only controls (currently: the canvas background upload, which posts to a super_admin-only API). */
  canAdminUpload?: boolean;
  /** Platform-starter authoring mode (super_admin). Load/save target
   *  /api/starter-templates instead of dealer/group templates; no dealer/group
   *  context; simplified Save modal. */
  starterMode?: boolean;
  /** When editing an existing starter in starterMode, its id (load source). */
  starterTemplateId?: string;
}

export default function BuilderPage({ vehicle, templateId, aiEnabled = false, customSizes = [], dealerId, dealerLogoUrl, dealerInfo, groupId, canAddCustomSize = false, canAdminUpload = false, starterMode = false, starterTemplateId }: Props) {
  const { setTitle } = useBuilderBreadcrumb();

  const [widgets, setWidgets] = useState<Record<string, Widget>>({});
  const [nid, setNid] = useState(1);
  const [selId, setSelId] = useState<string | null>(null);
  const [Z, setZ] = useState(0.75);
  const [paperSize, setPaperSize] = useState<string>('standard');
  const [fontScale, setFontScale] = useState(1.0);
  const [bgUrl, setBgUrl] = useState(BG_DEFAULT);
  // Super-admin canvas-background upload (replaces the unused "load from URL" field).
  // Posts to /api/admin/image-library/upload which is super_admin-only.
  const canvasBgFileRef = useRef<HTMLInputElement>(null);
  const [canvasBgUploading, setCanvasBgUploading] = useState(false);
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
  const [defaultTemplateIds, setDefaultTemplateIds] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // ID of the template currently loaded in the builder (for upsert-on-save logic)
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null);
  // When true, the loaded template came from a locked group_template
  // assignment — Save must refuse so the dealer can't overwrite corporate
  // content. Cleared when a fresh template is loaded or the canvas is reset.
  const [loadedTemplateLocked, setLoadedTemplateLocked] = useState(false);
  // Scope of the currently-loaded template: 'group' (a group_templates row) vs
  // 'dealer' (own templates row). Drives upsert-on-save so editing a loaded
  // template UPDATES it instead of creating a duplicate (a group template must
  // PATCH /api/group-templates, a dealer template must PATCH /api/templates).
  const [loadedTemplateSource, setLoadedTemplateSource] = useState<'dealer' | 'group' | null>(null);
  // Effective disclaimers for this dealer + current document_type, fetched
  // once on mount and re-applied to Disclaimer widgets at load/save time so
  // canvas preview matches print output.
  const disclaimersRef = useRef<Array<{ text: string; locked: boolean }>>([]);
  const [customWidgets, setCustomWidgets] = useState<CustomWidgetDef[]>(DEFAULT_CUSTOM_WIDGETS);
  const [saveVtypes, setSaveVtypes] = useState<Set<string>>(new Set(['new']));
  const [saveTname, setSaveTname] = useState('');
  const [saveDocType, setSaveDocType] = useState<'addendum' | 'infosheet' | 'buyers_guide'>('addendum');
  // In a group context (?group=… in the URL → groupId set) the only sensible
  // save target is the group template library — group_admin / ghost-mode
  // doesn't have a dealer to write to under /api/templates. Default the
  // toggle ON so Save Template works on first try.
  // Default to GROUP-scoped only at GROUP level. Once a group_admin has switched
  // into a dealer (dealerId set — active dealer), default to DEALER-scoped so the
  // save lands on that dealer (they're operating as the dealer, per the
  // group-admin-dealer-parity model). Previously this defaulted to true for ANY
  // group_admin, so a switched-in group_admin's save was routed to the group
  // template library instead of the dealer. They can still toggle it on to author
  // a group template.
  const [saveAsGroupTemplate, setSaveAsGroupTemplate] = useState<boolean>(() => Boolean(groupId) && !dealerId);
  const [nudge, setNudge] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const [printAiOverride, setPrintAiOverride] = useState<'db'|'ai'|'default'>('default');
  const [localCustomSizes, setLocalCustomSizes] = useState<CustomSize[]>(customSizes);
  const [showCustomSizesModal, setShowCustomSizesModal] = useState(false);
  const [showAddSizeModal, setShowAddSizeModal] = useState(false);
  const [showLogoPicker, setShowLogoPicker] = useState(false);
  const [showInfoboxLibPicker, setShowInfoboxLibPicker] = useState(false);
  const [showBgLibPicker, setShowBgLibPicker] = useState(false);
  // "+ New" starter picker (dealer/group Builder only). List of platform
  // starters offered alongside "Blank".
  const [showNewPicker, setShowNewPicker] = useState(false);
  const [starterPickerList, setStarterPickerList] = useState<Array<{ id: string; name: string; doc_type: string }>>([]);
  // The is_blank_default starter row id (migration 114). The "Blank" option loads
  // it instead of the hardcoded applyBlankCanvas; null = no record → fall back.
  const [blankStarterId, setBlankStarterId] = useState<string | null>(null);

  // Canonical dealer logo — pre-resolved S3 URL from the page server component.
  // Stays constant for the lifetime of this builder session.
  const canonicalLogoRef = useRef<string | null>(vehicle?.logo_url ?? dealerLogoUrl ?? null);

  // Dealer info for blank builder (no vehicle) — used to populate the dealer address widget.
  const dealerInfoRef = useRef<DealerInfo | undefined>(dealerInfo);

  // Dirty tracker: flipped true by any user edit, reset to false after init,
  // template load (manual or auto), or successful save. Read by the "+ New"
  // toolbar action to decide whether to prompt before discarding work. Stored
  // in a ref so flipping it doesn't trigger re-renders.
  const isDirtyRef = useRef(false);
  // Set the moment any user-intended canvas state lands (template load, edit
  // link, starter pick, new doc, save). The async group standard-layout
  // bootstrap (82db942/3f1a3dc) re-checks this right before applying so a
  // late-landing seed can never clobber a loaded template's tracking state.
  const seedSupersededRef = useRef(false);

  // Refs for drag
  const paperRef = useRef<HTMLDivElement>(null);
  const widgetsRef = useRef<Record<string, Widget>>({});
  const widgetEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<{
    mode: 'move' | 'resize'; id: string; dir?: string;
    ox: number; oy: number; sx: number; sy: number;
    origX: number; origY: number; origW: number; origH: number;
    // Pointer-capture bookkeeping: a drag only "starts" past a small movement
    // threshold, so a plain click selects without ever entering move mode.
    started: boolean; pointerId: number; el: HTMLElement | null;
  } | null>(null);
  const ZRef = useRef(Z);
  const paperSizeRef = useRef(paperSize);
  const customSizesRef = useRef<CustomSize[]>(customSizes);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set topbar breadcrumb
  useEffect(() => {
    const parts = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ');
    const stock = vehicle?.stock_number ? ` — ${vehicle.stock_number}` : '';
    setTitle(parts ? `${parts}${stock}` : null);
    return () => setTitle(null);
  }, [vehicle, setTitle]);

  // Keep refs in sync
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
  useEffect(() => { ZRef.current = Z; }, [Z]);
  useEffect(() => { paperSizeRef.current = paperSize; }, [paperSize]);
  useEffect(() => { customSizesRef.current = localCustomSizes; }, [localCustomSizes]);

  // ── Toast ──────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  // Canvas-background upload (super_admin). Posts to the admin image-library
  // route so the file lands in the same bucket the picker reads — the upload
  // shows up in the "Choose Background" list afterward without a refresh of
  // the picker's bucket query.
  const uploadCanvasBackground = useCallback(async (file: File) => {
    setCanvasBgUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('bucket', resolveIsInfosheet(paperSizeRef.current, customSizesRef.current) ? 'new-infosheet-backgrounds' : 'new-addendum-backgrounds');
      const res = await fetch('/api/admin/image-library/upload', { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (res.status === 201 && json.url) {
        setBgUrl(json.url);
        isDirtyRef.current = true;
        showToast('Background uploaded');
      } else {
        showToast(json.error ?? `Upload failed (${res.status})`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setCanvasBgUploading(false);
      if (canvasBgFileRef.current) canvasBgFileRef.current.value = '';
    }
  }, [showToast]);

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
    const isInfosheet = resolveIsInfosheet(paperSizeRef.current, customSizesRef.current);
    if (UNIQUE_WIDGETS.includes(type) && Object.values(widgetsRef.current).some(wg => wg.type === type as Widget['type'])) {
      showToast('Widget already on canvas — only one per template');
      return;
    }
    const id = 'w' + nid;
    const widget = makeWidget(type, id, x, y, w, h, isInfosheet);
    if (type === 'logo') widget.d = { ...widget.d, imgUrl: canonicalLogoRef.current ?? '' };
    // Newly-dropped Disclaimer widgets should preview the real text immediately.
    if (type === 'disclaimer') widget.d = { ...widget.d, disclaimers: disclaimersRef.current };
    setNid(n => n + 1);
    setWidgets(prev => {
      const next = { ...prev, [id]: widget };
      widgetsRef.current = next;
      if (!silent) pushHistory(next, nid + 1);
      return next;
    });
    if (!silent) { setSelId(id); isDirtyRef.current = true; }
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
    isDirtyRef.current = true;
  }, [nid, pushHistory]);

  // ── Update widget data field ───────────────────────────────────────
  const updateWidget = useCallback((id: string, key: string, value: unknown) => {
    setWidgets(prev => {
      const w = prev[id]; if (!w) return prev;
      const next = { ...prev, [id]: { ...w, d: { ...w.d, [key]: value } } };
      widgetsRef.current = next;
      return next;
    });
    isDirtyRef.current = true;
  }, []);

  const updateWidgetPos = useCallback((id: string, key: 'x'|'y'|'w'|'h', value: number) => {
    if (isNaN(value)) return;
    setWidgets(prev => {
      const w = prev[id]; if (!w) return prev;
      const next = { ...prev, [id]: { ...w, [key]: snapV(value) } };
      widgetsRef.current = next;
      return next;
    });
    isDirtyRef.current = true;
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
    isDirtyRef.current = true;
  }, []);

  const handleLayerChange = useCallback((id: string, action: 'front'|'back'|'forward'|'backward') => {
    isDirtyRef.current = true;
    setWidgets(prev => {
      const w = prev[id]; if (!w) return prev;
      const allZ = Object.values(prev).map(wg => wg.z ?? 10);
      const maxZ = Math.max(...allZ, 10);
      const minZ = Math.min(...allZ, 10);
      const curZ = w.z ?? 10;
      let newZ = curZ;
      if (action === 'front') newZ = maxZ + 1;
      else if (action === 'back') newZ = minZ - 1;
      else if (action === 'forward') newZ = curZ + 1;
      else if (action === 'backward') newZ = curZ - 1;
      const next = { ...prev, [id]: { ...w, z: newZ } };
      widgetsRef.current = next;
      pushHistory(next, nid);
      return next;
    });
  }, [nid, pushHistory]);

  // ── Drag/resize ────────────────────────────────────────────────────
  const startMove = useCallback((e: React.PointerEvent, id: string) => {
    if (previewMode || e.button !== 0) return;
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
      started: false, pointerId: e.pointerId, el: capturePointer(e),
    };
  }, [previewMode]);

  const startResize = useCallback((e: React.PointerEvent, id: string, dir: string) => {
    if (previewMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const w = widgetsRef.current[id];
    if (!w) return;
    dragRef.current = {
      mode: 'resize', id, dir,
      ox: 0, oy: 0,
      sx: e.clientX, sy: e.clientY,
      origX: w.x, origY: w.y, origW: w.w, origH: w.h,
      started: false, pointerId: e.pointerId, el: capturePointer(e),
    };
  }, [previewMode]);

  useEffect(() => {
    const DRAG_THRESHOLD = 4; // px of pointer travel before a press becomes a drag

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !paperRef.current || e.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        if (Math.abs(e.clientX - drag.sx) < DRAG_THRESHOLD && Math.abs(e.clientY - drag.sy) < DRAG_THRESHOLD) return;
        drag.started = true;
      }
      const w = widgetsRef.current[drag.id];
      if (!w) return;
      const Z = ZRef.current;
      const ps = paperSizeRef.current;
      const pr = paperRef.current.getBoundingClientRect();
      const { w: pw, h: ph } = getPaperDims(ps, customSizesRef.current);
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

    const endDrag = () => {
      const drag = dragRef.current;
      if (!drag) return;
      try { drag.el?.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
      dragRef.current = null;
      if (!drag.started) return; // plain click: selection only, no state write, no history entry
      setWidgets({ ...widgetsRef.current });
      const ws = widgetsRef.current;
      setNid(n => { pushHistory(ws, n); return n; });
    };

    const onUp = (e: PointerEvent) => {
      if (dragRef.current && e.pointerId !== dragRef.current.pointerId) return;
      endDrag();
    };
    const onBlur = () => endDrag();

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [pushHistory]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // Also bail on contenteditable — the Custom Text panel's RichTextEditor
      // (tiptap) is a contenteditable DIV, so a tag check alone lets Backspace
      // fall through and delete the selected widget mid-typing.
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId) deleteWidget(selId);
      if (e.key === 'Escape') setSelId(null);
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey)) ) { e.preventDefault(); redo(); }
      if (selId && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.metaKey || e.ctrlKey ? 10 : e.shiftKey ? 4 : 1;
        setWidgets(prev => {
          const w = prev[selId]; if (!w) return prev;
          const { w: pw, h: ph } = getPaperDims(paperSizeRef.current, customSizesRef.current);
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
    // bgimage replaces the old monolithic 'infobox' slot — new templates get
    // the EPA/DOT Fuel Economy image pre-placed (DEFS.bgimage sets imgUrl).
    //
    // A new GROUP-template document (?group= context) seeds the SAME standard
    // layout a new dealer doc gets (Allan decision 2026-08-12, reversing
    // e080d62's open-blank behavior): the base widget set is a ready starting
    // point; a truly-empty canvas stays available as the explicit "Blank"
    // choice in the "+ New" picker. Editing an EXISTING group template
    // (templateId set) is loaded by the template-load effect below.
    const order = ['logo','vehicle','msrp','options','subtotal','askbar','dealer','bgimage'];
    let nextNid = 1;
    let ws: Record<string, Widget> = {};
    order.forEach(type => {
      const id = 'w' + nextNid++;
      ws[id] = makeWidget(type, id);
    });
    if (vehicle) {
      // Set vehicle fields list first
      Object.values(ws).forEach(w => {
        if (w.type === 'vehicle') w.d = { ...w.d, fields: ['stock','vin','year','color','make','trim','model'] };
      });
      // Populate all widgets with real vehicle/dealer data
      ws = applyVehicleDataToWidgets(ws, vehicle);
    } else if (dealerInfoRef.current) {
      // Blank builder: populate dealer address widget from server-fetched dealer data
      ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
    }
    // Always apply canonical dealer logo to logo widgets (works with or without a vehicle)
    ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
    ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
    widgetsRef.current = ws;
    setWidgets(ws);
    setNid(nextNid);
    pushHistory(ws, nextNid);
    isDirtyRef.current = false;
    if (vehicle) setTemplateName(`${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'New Template');
    // Load dealer settings (nudge margins)
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(data => {
      if (data) setNudge({ left: data.nudge_left || 0, right: data.nudge_right || 0, top: data.nudge_top || 0, bottom: data.nudge_bottom || 0 });
    }).catch(() => {});
    // Load effective group disclaimers for this dealer once on mount. Cached
    // on disclaimersRef and re-applied to Disclaimer widgets at every load /
    // paper-switch path.
    // Use the active dealer (dealerId prop) so the blank builder works for a
    // group_admin-as-dealer too, not just the vehicle builder (vehicle.dealer_id).
    const eid = dealerId ?? vehicle?.dealer_id ?? null;
    const dqs = eid ? `?dealer_id=${encodeURIComponent(eid)}` : '';
    fetch(`/api/disclaimers${dqs}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { data?: Array<{ text: string; locked: boolean }> } | null) => {
        if (!j?.data) return;
        disclaimersRef.current = j.data;
        // Backfill any disclaimer widgets that were placed before this resolved.
        setWidgets(prev => applyDisclaimerToWidgets(prev, j.data!));
        widgetsRef.current = applyDisclaimerToWidgets(widgetsRef.current, j.data);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load: on the blank /builder route, open the dealer's most recently
  // updated saved template so returning visits resume work-in-progress
  // instead of dropping the user on an empty canvas. Skipped when:
  // - templateId URL param is set (explicit navigation always wins)
  // - groupId is set (group library has its own selection semantics)
  // - vehicle is bound (the vehicle builder resolves defaults server-side)
  // - no dealer scope to read templates against
  // The load is silent (no toast). applyLogoToWidgets re-resolves the dealer
  // logo at this point so a logo-uploaded-in-Settings change reflects on the
  // next Builder open without requiring a re-save of the template.
  useEffect(() => {
    if (templateId) return;
    if (groupId) return;
    if (vehicle) return;
    const effDealerId = dealerId ?? null;
    if (!effDealerId) return;
    let cancelled = false;
    (async () => {
      try {
        // Fetch the template list AND dealer_settings together so we can prefer
        // the dealer's CONFIGURED default (default_addendum_new) over merely the
        // most-recently-updated template. Both endpoints resolve the same dealer
        // via ?dealer_id=, so this matches what Print Settings shows.
        const dqs = `?dealer_id=${encodeURIComponent(effDealerId)}`;
        const [listRes, settingsRes] = await Promise.all([
          fetch(`/api/templates${dqs}`),
          fetch(`/api/settings${dqs}`),
        ]);
        if (!listRes.ok) return;
        const listJson = await listRes.json() as { data?: SavedTemplate[] };
        const rows = listJson.data ?? [];
        let defaultAddendumNew: string | null = null;
        if (settingsRes.ok) {
          const sJson = await settingsRes.json() as { data?: { default_addendum_new?: string | null } };
          defaultAddendumNew = sJson.data?.default_addendum_new ?? null;
        }
        if (cancelled) return;
        if (rows.length === 0) {
          // First-time open — no saved templates yet. Bootstrap from the
          // SuperAdmin-curated blank-default starter so the canvas matches
          // what "+ New → Blank" produces. Fall back to the hardcoded
          // defaults only if no blank starter exists or it has no layout.
          try {
            const sListRes = await fetch('/api/starter-templates');
            if (!cancelled && sListRes.ok) {
              const sListJson = await sListRes.json() as { data?: Array<{ id: string; is_blank_default?: boolean }> };
              const blankRow = (sListJson.data ?? []).find(s => s.is_blank_default);
              if (!cancelled && blankRow) {
                const sRes = await fetch(`/api/starter-templates/${blankRow.id}`);
                if (!cancelled && sRes.ok) {
                  const sPayload = await sRes.json();
                  const sTmpl = sPayload?.data as { template_json?: Record<string, unknown>; is_blank_default?: boolean } | null;
                  const sTj = (sTmpl?.template_json ?? {}) as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: string };
                  if (sTj.widgets && Object.keys(sTj.widgets).length > 0) {
                    const ps = sTj.paperSize ?? 'standard';
                    const { w: pw, h: ph } = getPaperDims(ps, customSizesRef.current);
                    let ws = sTj.widgets;
                    let n = sTj.nid ?? 1;
                    ws = convertLegacyInfoboxes(ws);
                    [ws, n] = ensureAskbar(ws, n, ps);
                    ws = clampWidgets(ws, pw, ph);
                    if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
                    ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
                    ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
                    if (cancelled) return;
                    setWidgets(ws); widgetsRef.current = ws;
                    setNid(n);
                    if (sTj.bgUrl) setBgUrl(sTj.bgUrl);
                    setFontScale(typeof sTj.fontScale === 'number' ? sTj.fontScale : 1.0);
                    setPaperSize(ps); paperSizeRef.current = ps;
                    setLoadedTemplateId(null);
                    setLoadedTemplateLocked(false);
                    setLoadedTemplateSource(null);
                    setSelId(null);
                    setTemplateName('New Template');
                    setHistory([JSON.stringify({ widgets: ws, nid: n })]);
                    setHistIdx(0);
                    isDirtyRef.current = false;
                    return;
                  }
                }
              }
            }
          } catch { /* fall through to applyBlankCanvas */ }
          // No blank starter with a saved layout — use hardcoded defaults.
          if (!cancelled) applyBlankCanvas();
          return;
        }
        // Prefer the dealer's CONFIGURED default template (default_addendum_new
        // from dealer_settings) when it resolves to a template in this list —
        // this is the same template the Print Settings default dropdown points
        // at, so the Builder opens on the dealer's intended default. This works
        // for a group-ASSIGNED default too (rows carry the group_template id, and
        // the detail loader below handles source === 'group'). Fall back to the
        // most-recently-updated own template (then any row) when no default is
        // configured, so returning visits still resume work-in-progress and the
        // auto-open never surprises the user with a 🔒 Locked surface.
        const sorted = [...rows].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
        const pick = (defaultAddendumNew ? rows.find(t => t.id === defaultAddendumNew) : undefined)
          ?? sorted.find(t => t.source !== 'group')
          ?? sorted[0];
        if (cancelled || !pick) return;
        const detailUrl = pick.source === 'group' && pick.group_id
          ? `/api/group-templates/${pick.group_id}/${pick.id}`
          : `/api/templates/${pick.id}`;
        const detailRes = await fetch(detailUrl);
        if (cancelled || !detailRes.ok) return;
        const detailPayload = await detailRes.json();
        const tmpl = (detailPayload && typeof detailPayload === 'object' && 'data' in detailPayload)
          ? (detailPayload as { data?: Record<string, unknown> }).data
          : detailPayload as Record<string, unknown>;
        if (cancelled || !tmpl) return;
        const tj = tmpl.template_json as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: string } | undefined;
        if (!tj?.widgets || Object.keys(tj.widgets).length === 0) return;
        const ps = tj.paperSize ?? 'standard';
        const { w: pw, h: ph } = getPaperDims(ps, customSizesRef.current);
        let ws = tj.widgets;
        let n = tj.nid ?? 1;
        ws = convertLegacyInfoboxes(ws);
        [ws, n] = ensureAskbar(ws, n, ps);
        ws = clampWidgets(ws, pw, ph);
        if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
        ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
        ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
        if (cancelled) return;
        setWidgets(ws);
        widgetsRef.current = ws;
        setNid(n);
        if (tj.bgUrl) { setBgUrl(tj.bgUrl); }
        if (typeof tj.fontScale === 'number') setFontScale(tj.fontScale);
        if (tj.paperSize) { setPaperSize(tj.paperSize); paperSizeRef.current = tj.paperSize; }
        setTemplateName((tmpl.name as string) || 'Template');
        setLoadedTemplateId(pick.id);
        setLoadedTemplateSource(pick.source === 'group' ? 'group' : 'dealer');
        setSaveAsGroupTemplate(pick.source === 'group');
        const locked = pick.source === 'group' && pick.is_locked !== false;
        setLoadedTemplateLocked(locked);
        isDirtyRef.current = false;
      } catch { /* silent — fall back to the default canvas */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GROUP new-document bootstrap (2026-08-12): a fresh group-mode Builder
  // (?group=, no templateId) silently upgrades the hardcoded mount seed to the
  // SuperAdmin-curated blank-default starter — the SAME complete base a new
  // dealer doc gets, widgets AND its baked-in background. (The mount seed's
  // hardcoded set + BG_DEFAULT remains the fallback when no starter exists.)
  // Stays an UNSAVED new document: loadedTemplateId null, group save target.
  useEffect(() => {
    if (templateId || starterMode) return;
    if (!groupId || dealerId) return;
    let cancelled = false;
    (async () => {
      try {
        const sListRes = await fetch('/api/starter-templates');
        if (cancelled || !sListRes.ok) return;
        const sListJson = await sListRes.json() as { data?: Array<{ id: string; is_blank_default?: boolean }> };
        const blankRow = (sListJson.data ?? []).find(s => s.is_blank_default);
        if (cancelled || !blankRow) return;
        const sRes = await fetch(`/api/starter-templates/${blankRow.id}`);
        if (cancelled || !sRes.ok) return;
        const sPayload = await sRes.json();
        const sTmpl = sPayload?.data as { template_json?: Record<string, unknown> } | null;
        const sTj = (sTmpl?.template_json ?? {}) as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: string };
        if (!sTj.widgets || Object.keys(sTj.widgets).length === 0) return;
        // Don't clobber work: bail if the operator already touched the canvas
        // OR any deliberate load/new/save landed while we were fetching —
        // nulling loadedTemplateId after a template Load would flip the next
        // Save from PATCH to POST and mint a "{name} v2" duplicate.
        if (isDirtyRef.current || seedSupersededRef.current) return;
        const ps = sTj.paperSize ?? 'standard';
        const { w: pw, h: ph } = getPaperDims(ps, customSizesRef.current);
        let ws = sTj.widgets;
        let n = sTj.nid ?? 1;
        ws = convertLegacyInfoboxes(ws);
        [ws, n] = ensureAskbar(ws, n, ps);
        ws = clampWidgets(ws, pw, ph);
        if (cancelled) return;
        setWidgets(ws); widgetsRef.current = ws;
        setNid(n);
        if (sTj.bgUrl) setBgUrl(sTj.bgUrl);
        setFontScale(typeof sTj.fontScale === 'number' ? sTj.fontScale : 1.0);
        setPaperSize(ps); paperSizeRef.current = ps;
        setLoadedTemplateId(null);
        setLoadedTemplateLocked(false);
        setLoadedTemplateSource(null);
        setSelId(null);
        setTemplateName('New Template');
        setHistory([JSON.stringify({ widgets: ws, nid: n })]);
        setHistIdx(0);
        isDirtyRef.current = false;
      } catch { /* silent — the hardcoded mount seed stays */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load template if templateId provided. When groupId is set we fetch from the
  // group-templates route so super_admin / group_admin can edit shared templates;
  // otherwise the dealer-templates route is used.
  useEffect(() => {
    const editId = starterMode ? starterTemplateId : templateId;
    if (!editId) return;
    const url = starterMode
      ? `/api/starter-templates/${editId}`
      : groupId
        ? `/api/group-templates/${groupId}/${editId}`
        : `/api/templates/${editId}`;
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(payload => {
        if (!payload) return;
        // Group route returns { data: row }; dealer route returns row directly.
        const data = (payload && typeof payload === 'object' && 'data' in payload)
          ? payload.data as Record<string, unknown>
          : payload as Record<string, unknown>;
        if (!data) return;
        const json = data.template_json as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: string };
        if (json?.widgets) {
          const ps = json.paperSize ?? 'standard';
          const { w: pw, h: ph } = getPaperDims(ps, customSizesRef.current);
          let ws = json.widgets;
          let n = json.nid ?? 1;
          ws = convertLegacyInfoboxes(ws);
          [ws, n] = ensureAskbar(ws, n, ps);
          ws = clampWidgets(ws, pw, ph);
          if (vehicle) ws = applyVehicleDataToWidgets(ws, vehicle);
          else if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
          ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
    ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
          setWidgets(ws);
          widgetsRef.current = ws;
          setNid(n);
        }
        if (json?.bgUrl) { setBgUrl(json.bgUrl); }
        if (json?.fontScale) setFontScale(json.fontScale);
        if (json?.paperSize) setPaperSize(json.paperSize);
        setTemplateName((data.name as string) || 'Template');
        setLoadedTemplateId(editId);
        // Derive scope from the load PATH, exactly like loadTemplate: loaded via
        // the group endpoint ⇒ 'group'. This effect historically NEVER set
        // loadedTemplateSource, so a group template opened via the Templates-tab
        // Edit link re-saved as a POST (source null failed the PATCH guard) and
        // the server's collision backstop minted "{name} v2" — the "New AN 2 v2"
        // regression (2026-08-14). Sync the group-save toggle too.
        const viaGroup = !starterMode && !!groupId;
        setLoadedTemplateSource(viaGroup ? 'group' : 'dealer');
        if (!starterMode) setSaveAsGroupTemplate(viaGroup);
        seedSupersededRef.current = true;
        setLoadedTemplateLocked(data.source === 'group' && data.is_locked !== false);
        if (starterMode) {
          const dt = data.doc_type as string | undefined;
          if (dt === 'addendum' || dt === 'infosheet' || dt === 'buyers_guide') setSaveDocType(dt);
        }
        isDirtyRef.current = false;
      })
      .catch(() => {});
  }, [templateId, groupId, starterMode, starterTemplateId]);

  // ── Paper size switch ──────────────────────────────────────────────
  const switchPaperSize = useCallback((size: string) => {
    isDirtyRef.current = true;
    setPaperSize(size);
    paperSizeRef.current = size;
    if (size === 'infosheet') {
      setBgUrl(IS_BG_DEFAULT);
      // Load infosheet default layout
      const order = ['logo','vehicle','description','features','askbar','qrcode','barcode','dealer','customtext'];
      let nextNid = 1;
      let ws: Record<string, Widget> = {};
      order.forEach(type => {
        const def = LAYOUT_INFOSHEET[type];
        if (!def) return;
        const id = 'w' + nextNid++;
        ws[id] = makeWidget(type, id, def.x, def.y, def.w, def.h, true);
        // Infosheet font overrides
        if (type === 'askbar') { ws[id].d = { ...ws[id].d, labelFontSize: 1.6, valueFontSize: 1.9 }; }
        if (type === 'vehicle') { ws[id].d = { ...ws[id].d, headerFontSize: 1.2 }; }
      });
      if (vehicle) ws = applyVehicleDataToWidgets(ws, vehicle);
      else if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
      const wsWithLogo = applyDisclaimerToWidgets(applyLogoToWidgets(ws, canonicalLogoRef.current), disclaimersRef.current);
      widgetsRef.current = wsWithLogo;
      setWidgets(wsWithLogo);
      setNid(nextNid);
      setSelId(null);
      pushHistory(wsWithLogo, nextNid);
      showToast('Infosheet layout loaded');
      // Auto-load AI content when switching to infosheet with a vehicle
      if (vehicle) {
        setAiPendingLoad(true);
      }
    } else {
      const { w: pw, h: ph } = getPaperDims(size, customSizesRef.current);
      const matchedCustom = customSizesRef.current.find(c => c.id === size);
      const customBg = matchedCustom?.background_url ?? null;
      // Custom infosheet sizes start BLANK — the portrait LAYOUT_INFOSHEET
      // coords (816×1056) don't apply to a landscape 11×8.5 canvas, and the
      // addendum LAYOUT below is the wrong widget set for an infosheet. The
      // user places widgets by hand on top of their uploaded background.
      // (For the built-in 'infosheet' the early branch above still loads
      // the portrait layout.)
      if (matchedCustom?.doc_type === 'infosheet') {
        setBgUrl(customBg ?? IS_BG_DEFAULT);
        widgetsRef.current = {};
        setWidgets({});
        setNid(1);
        setSelId(null);
        pushHistory({}, 1);
        return;
      }
      // Scale widget x/w proportionally when canvas width differs from the standard 408px reference
      const scaleW = pw / PAPERS.standard.w;
      setBgUrl(customBg ?? BG_DEFAULT);
      // bgimage replaces the old monolithic 'infobox' slot — new templates get
    // the EPA/DOT Fuel Economy image pre-placed (DEFS.bgimage sets imgUrl).
    const order = ['logo','vehicle','msrp','options','subtotal','askbar','dealer','bgimage'];
      let nextNid = 1;
      let ws: Record<string, Widget> = {};
      order.forEach(type => {
        const id = 'w' + nextNid++;
        if (scaleW !== 1) {
          const layout = LAYOUT[type] ?? { x: 12, y: 200, w: 384, h: 60 };
          ws[id] = makeWidget(type, id, Math.round(layout.x * scaleW), layout.y, Math.round(layout.w * scaleW), layout.h);
        } else {
          ws[id] = makeWidget(type, id);
        }
      });
      ws = clampWidgets(ws, pw, ph);
      if (vehicle) ws = applyVehicleDataToWidgets(ws, vehicle);
      else if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
      ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
    ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
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
    const pw = getPaperDims(paperSizeRef.current, customSizesRef.current).w;
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
      const docType = resolveIsInfosheet(paperSize, customSizesRef.current) ? 'infosheet' : 'addendum';
      const res = await fetch('/api/pdf/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealerVehicleId: vehicle.id,
          widgets: Object.values(widgetsRef.current),
          paperSize,
          fontScale,
          bgUrl,
          docType,
        }),
      });
      if (!res.ok) {
        const json = await res.json() as { error?: string };
        showToast(json.error ?? 'PDF generation failed');
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${vehicle.year ?? ''}_${vehicle.make ?? ''}_${vehicle.model ?? ''}_${vehicle.stock_number || vehicle.id}.pdf`.replace(/\s+/g, '_');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      showToast('PDF downloaded');
    } catch {
      showToast('PDF generation failed');
    } finally {
      setPdfLoading(false);
    }
  }, [vehicle, paperSize, fontScale, bgUrl, showToast]);

  // ── Save template ──────────────────────────────────────────────────
  const saveTemplate = useCallback(async (asCopy: boolean = false) => {
    seedSupersededRef.current = true;
    // Platform-starter mode: save to /api/starter-templates (name + doc_type +
    // paper + layout). No dealer/group context, no vehicle-type defaults.
    if (starterMode) {
      const name = saveTname.trim() || templateName;
      if (!name) { showToast('Name is required'); return; }
      const body = {
        name,
        doc_type: saveDocType,
        paper: paperSize,
        template_json: { widgets: widgetsRef.current, nid, bgUrl, fontScale, paperSize },
      };
      try {
        const editId = starterTemplateId ?? loadedTemplateId;
        const r = editId
          ? await fetch(`/api/starter-templates/${editId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          : await fetch('/api/starter-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); showToast((j as { error?: string }).error || 'Save failed — try again'); return; }
        const { data } = await r.json() as { data?: { id: string } };
        if (data?.id) setLoadedTemplateId(data.id);
        setTemplateName(name);
        setShowSave(false);
        isDirtyRef.current = false;
        showToast(`✓ Starter layout saved: ${name}`);
      } catch { showToast('Save failed — try again'); }
      return;
    }
    if (loadedTemplateLocked) {
      showToast('Group templates cannot be saved — contact your group admin');
      return;
    }
    // In group context there's no dealer to save to. Without the toggle on,
    // the dealer-save path 400s ("dealer_id param required") — refuse early
    // with a clearer message.
    const effectiveDealerId = dealerId ?? vehicle?.dealer_id ?? null;
    if (groupId && !effectiveDealerId && !saveAsGroupTemplate) {
      showToast('Turn on “Save as Group Template” to save in group context');
      return;
    }
    const name = saveTname.trim() || templateName;
    if (!name) return;
    const isDraft = saveVtypes.has('draft');
    const vtypes = Array.from(saveVtypes).filter(v => v !== 'draft');
    const body = {
      name,
      document_type: saveDocType,
      vehicle_types: vtypes.length ? vtypes : ['new'],
      template_json: { widgets: widgetsRef.current, nid, bgUrl, fontScale, paperSize },
      is_active: !isDraft,
    };
    try {
      // Group template path: save to group_templates table.
      if (saveAsGroupTemplate && groupId) {
        // Save = UPDATE the loaded group template (rename included) — once a
        // template has been saved this session it holds its id + source, so
        // every subsequent Save PATCHes the same row instead of POSTing a
        // duplicate. (The previous `name === templateName` guard re-POSTed on
        // the very next save because the group branch never synced templateName,
        // creating the "New Vehicle Template" duplicates.) "Save as new copy"
        // (asCopy) deliberately creates a fresh "{name} v2" row; the server
        // bumps to v3… if v2 is taken and also guards plain saves against
        // exact-duplicate names.
        const editGroupId = (!asCopy && loadedTemplateSource === 'group' && loadedTemplateId) ? loadedTemplateId : null;
        const sendName = (!editGroupId && asCopy) ? `${name.replace(/\s+v\d+$/i, '')} v2` : name;
        const groupBody = { ...body, name: sendName };
        const r = editGroupId
          ? await fetch(`/api/group-templates/${groupId}/${editGroupId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(groupBody) })
          : await fetch(`/api/group-templates/${groupId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(groupBody) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); showToast((j as { error?: string }).error || 'Save failed — try again'); return; }
        const { data: savedGt } = await r.json().catch(() => ({ data: null })) as { data?: { id: string; name?: string } };
        const finalName = savedGt?.name ?? sendName;
        if (savedGt?.id) {
          setLoadedTemplateId(savedGt.id);
          setLoadedTemplateSource('group');
          // Sync the name state so the toolbar shows "Editing: {name} (Group
          // Template)" and the NEXT save PATCHes this same row.
          setTemplateName(finalName);
          setSaveTname(finalName);
        }
        setShowSave(false);
        isDirtyRef.current = false;
        showToast(`✓ Group template ${editGroupId ? 'updated' : (asCopy ? 'copied' : 'saved')}: ${finalName}`);
        return;
      }

      // Determine whether to update an existing template or create a new one:
      // 1. If a template was loaded and the name is unchanged → PATCH that ID
      // 2. If a template with this name already exists for this dealer → PATCH it
      // 3. Otherwise → POST (create new)
      let existingId: string | null = null;
      if (loadedTemplateId && name === templateName && loadedTemplateSource !== 'group') {
        existingId = loadedTemplateId;
      } else {
        // Only an OWN (dealer) template can be PATCHed via /api/templates/[id].
        // Never match a group-source row — its id is a group_templates id, which
        // 404s on the dealer endpoint ("Template not found").
        const match = savedTemplates.find(t => t.name.trim() === name && t.source !== 'group');
        if (match) existingId = match.id;
      }

      let savedId: string | null = null;
      let wasUpdate = false;

      // Pass the active dealer so a group_admin-as-dealer save resolves server-side
      // even without relying on the claims fallback (mirrors the list GET above).
      const dqs = effectiveDealerId ? `?dealer_id=${encodeURIComponent(effectiveDealerId)}` : '';

      if (existingId) {
        const r = await fetch(`/api/templates/${existingId}${dqs}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok) {
          const { data } = await r.json() as { data?: { id: string } };
          savedId = data?.id ?? existingId;
          wasUpdate = true;
        } else if (r.status === 404) {
          // The loaded id isn't THIS dealer's template — e.g. a group template was
          // auto-loaded into the canvas (its id is a group_templates id), or the
          // row was since deleted. Fall through to create a new dealer template
          // instead of failing with "Template not found".
          existingId = null;
        } else {
          const j = await r.json().catch(() => ({})); showToast((j as { error?: string }).error || 'Save failed — try again'); return;
        }
      }
      if (!savedId) {
        const r = await fetch(`/api/templates${dqs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); showToast((j as { error?: string }).error || 'Save failed — try again'); return; }
        const { data: savedData } = await r.json() as { data?: { id: string } };
        savedId = savedData?.id ?? null;
      }

      setTemplateName(name);
      if (savedId) { setLoadedTemplateId(savedId); setLoadedTemplateSource('dealer'); }
      setShowSave(false);
      isDirtyRef.current = false;

      if (!isDraft && savedId) {
        const isAll = saveVtypes.has('all');
        const dtKey = saveDocType === 'infosheet' ? 'infosheet' : 'addendum';
        const settingsPatch: Record<string, string> = {};
        if (isAll || saveVtypes.has('new'))  settingsPatch[`default_${dtKey}_new`]  = savedId;
        if (isAll || saveVtypes.has('used')) settingsPatch[`default_${dtKey}_used`] = savedId;
        if (isAll || saveVtypes.has('cpo'))  settingsPatch[`default_${dtKey}_cpo`]  = savedId;
        if (Object.keys(settingsPatch).length > 0) {
          const eid = dealerId ?? vehicle?.dealer_id ?? null;
          const sqs = eid ? `?dealer_id=${encodeURIComponent(eid)}` : '';
          const settingsRes = await fetch(`/api/settings${sqs}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settingsPatch) });
          if (!settingsRes.ok) {
            showToast('Template saved, but could not set as default. Please assign it manually in Settings.');
            return;
          }
          const label = isAll ? 'All' : vtypes.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join('/');
          showToast(`✓ Template ${wasUpdate ? 'updated' : 'saved'} and set as default for ${label} vehicles`);
          return;
        }
      }
      showToast(wasUpdate ? `✓ Template updated: ${name}` : `✓ Template saved: ${name}`);
    } catch {
      showToast('Save failed — try again');
    }
  }, [saveTname, templateName, saveDocType, saveVtypes, saveAsGroupTemplate, groupId, nid, bgUrl, fontScale, paperSize, showToast, loadedTemplateId, loadedTemplateLocked, loadedTemplateSource, savedTemplates, dealerId, vehicle?.dealer_id, starterMode, starterTemplateId]);

  // ── Copy template (Open Template modal action, 2026-08-10) ─────────
  // Full duplicate of the source's row (widget JSON + doc type + applies-to;
  // paper size / fontScale / background live inside template_json) as a NEW
  // independent template: never a default, never assigned to dealers — the
  // operator Loads and tweaks it. Name = "{source} (copy)" / "(copy N)";
  // the group POST's v2-suffix guard stays as a race backstop. A fresh copy
  // is always a CREATE (eef9e5a create-vs-PATCH semantics). Not offered on
  // Starter Layout rows ("Start from" is the copy-into-canvas there) or on
  // group-sourced rows in DEALER context (copying would clone a
  // group-managed layout past its lock — the assign modal governs that).
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const copyTemplate = useCallback(async (t: SavedTemplate) => {
    setCopyingId(t.id);
    try {
      // Fetch the source fresh (no-store — modal list rows can be slim) via
      // the same read path loadTemplate uses for this context.
      const srcUrl = groupId ? `/api/group-templates/${groupId}/${t.id}` : `/api/templates/${t.id}`;
      const r = await fetch(srcUrl, { cache: 'no-store' });
      if (!r.ok) { showToast('Copy failed — could not load the source template'); return; }
      const src = (await r.json()).data as {
        name?: string; document_type?: string; vehicle_types?: string[];
        template_json?: Record<string, unknown>; is_locked?: boolean;
      } | null;
      if (!src?.template_json || Object.keys(src.template_json).length === 0) {
        showToast('This template has no saved layout to copy.');
        return;
      }
      const names = new Set(savedTemplates.map(x => (x.name ?? '').trim()));
      let name = `${t.name} (copy)`;
      for (let n = 2; names.has(name); n++) name = `${t.name} (copy ${n})`;
      const eid = dealerId ?? vehicle?.dealer_id ?? null;
      const dstUrl = groupId
        ? `/api/group-templates/${groupId}`
        : `/api/templates${eid ? `?dealer_id=${encodeURIComponent(eid)}` : ''}`;
      const res = await fetch(dstUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          document_type: src.document_type ?? t.document_type,
          vehicle_types: src.vehicle_types ?? t.vehicle_types ?? [],
          template_json: src.template_json,
          // Group copies keep the source's lock state (a full duplicate);
          // dealer templates have no lock concept.
          ...(groupId ? { is_locked: src.is_locked ?? false } : {}),
        }),
      });
      const j = await res.json().catch(() => ({} as { data?: SavedTemplate; error?: string }));
      if (!res.ok) { showToast((j as { error?: string }).error || 'Copy failed'); return; }
      const created = (j as { data?: SavedTemplate }).data;
      // Refresh the modal list in place — created rows sort newest-first.
      if (created) setSavedTemplates(prev => [created, ...prev]);
      showToast(`Copied to "${created?.name ?? name}"`);
    } catch {
      showToast('Copy failed');
    } finally {
      setCopyingId(null);
    }
  }, [groupId, dealerId, vehicle, savedTemplates, showToast]);

  // ── Load templates list ────────────────────────────────────────────
  const openTemplates = useCallback(async () => {
    // Starter mode lists platform starters; no per-dealer defaults.
    if (starterMode) {
      try {
        const r = await fetch('/api/starter-templates');
        if (r.ok) { const j = await r.json(); setSavedTemplates(j.data ?? []); }
      } catch {}
      setDefaultTemplateIds(new Set());
      setDeleteConfirmId(null);
      setShowOpenModal(true);
      return;
    }
    try {
      const eid = dealerId ?? vehicle?.dealer_id ?? null;
      const qs = eid ? `?dealer_id=${encodeURIComponent(eid)}` : '';
      // In group context (group ghost mode or group_admin / super_admin opening
      // via ?group=) the Builder reads from the group's template library
      // instead of the dealer one. group_templates rows have name + id, so
      // the existing modal renders them identically.
      const templatesUrl = groupId ? `/api/group-templates/${groupId}` : `/api/templates${qs}`;
      const [tRes, sRes] = await Promise.all([fetch(templatesUrl), fetch(`/api/settings${qs}`)]);
      if (tRes.ok) { const j = await tRes.json(); setSavedTemplates(j.data ?? []); }
      // Group mode: also list the platform Starter Layouts below the group's
      // templates, so a fresh group isn't a dead end (dealer modal unchanged).
      if (groupId && !dealerId) {
        try {
          const r = await fetch('/api/starter-templates');
          if (r.ok) {
            const j = await r.json() as { data?: Array<{ id: string; name: string; doc_type: string; is_blank_default?: boolean }> };
            const all = j.data ?? [];
            setBlankStarterId(all.find(s => s.is_blank_default)?.id ?? null);
            setStarterPickerList(all.filter(s => !s.is_blank_default && (s.doc_type === 'addendum' || s.doc_type === 'infosheet')));
          }
        } catch { /* starters section just stays empty */ }
      }
      if (sRes.ok) {
        const sj = await sRes.json() as { data?: Record<string, string | null> };
        const defaults = new Set(
          Object.entries(sj.data ?? {})
            .filter(([k]) => k.startsWith('default_') && k !== 'default_template_new' && k !== 'default_template_used' && k !== 'default_template_cpo')
            .map(([, v]) => v)
            .filter((v): v is string => !!v)
        );
        setDefaultTemplateIds(defaults);
      }
    } catch {}
    setDeleteConfirmId(null);
    setShowOpenModal(true);
  }, [dealerId, vehicle?.dealer_id, groupId, starterMode]);

  const loadTemplate = useCallback(async (id: string) => {
    seedSupersededRef.current = true;
    try {
      // Match the read path used by openTemplates — starter templates in
      // starter mode, group_templates when scoped to a group, dealer otherwise.
      const url = starterMode
        ? `/api/starter-templates/${id}`
        : groupId ? `/api/group-templates/${groupId}/${id}` : `/api/templates/${id}`;
      const r = await fetch(url);
      if (!r.ok) { showToast('Failed to load template'); return; }
      const resp = await r.json();
      const tmpl = resp.data as { template_json?: Record<string, unknown>; name?: string; is_locked?: boolean; source?: string; doc_type?: string } | null;
      if (!tmpl?.template_json || Object.keys(tmpl.template_json).length === 0) {
        showToast('This template has no saved layout. Please re-save it from the Builder.');
        return;
      }
      const isLocked = tmpl.source === 'group' && tmpl.is_locked !== false;
      setLoadedTemplateLocked(isLocked);
      const json = tmpl.template_json as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: string };
      if (!json.widgets || Object.keys(json.widgets).length === 0) {
        showToast('This template has no saved layout. Please re-save it from the Builder.');
        return;
      }
      const ps = json.paperSize ?? 'standard';
      const { w: pw, h: ph } = getPaperDims(ps, customSizesRef.current);
      let ws = json.widgets;
      let n = json.nid ?? 1;
      ws = convertLegacyInfoboxes(ws);
      [ws, n] = ensureAskbar(ws, n, ps);
      ws = clampWidgets(ws, pw, ph);
      if (vehicle) ws = applyVehicleDataToWidgets(ws, vehicle);
      else if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
      ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
    ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
      setWidgets(ws); widgetsRef.current = ws;
      setNid(n);
      if (json.bgUrl) { setBgUrl(json.bgUrl); }
      if (json.fontScale) setFontScale(json.fontScale);
      if (json.paperSize) { setPaperSize(json.paperSize); paperSizeRef.current = json.paperSize; }
      if (starterMode && (tmpl.doc_type === 'addendum' || tmpl.doc_type === 'infosheet' || tmpl.doc_type === 'buyers_guide')) {
        setSaveDocType(tmpl.doc_type);
      }
      setTemplateName(tmpl.name || 'Template');
      setLoadedTemplateId(id);
      // The group-templates detail GET doesn't tag rows with `source`, so derive
      // scope from the load PATH: loaded via the group endpoint (groupId set,
      // non-starter) ⇒ group, else dealer. Sync the "Save as Group Template"
      // toggle to match so re-saving UPDATES the loaded template rather than
      // creating a duplicate.
      const loadedViaGroup = !starterMode && !!groupId;
      setLoadedTemplateSource(loadedViaGroup ? 'group' : 'dealer');
      if (!starterMode) setSaveAsGroupTemplate(loadedViaGroup);
      setSelId(null);
      setShowOpenModal(false);
      isDirtyRef.current = false;
      showToast(`Loaded: ${tmpl.name || 'Template'}`);
    } catch {
      showToast('Failed to load template');
    }
  }, [showToast, groupId, starterMode]);

  // ── New template ───────────────────────────────────────────────────
  // Resets the canvas to the default blank layout. Mirrors the work the
  // init useEffect does on mount, plus history/state cleanup so the user
  // can't undo back into the previous template's state. Prompts when there
  // are unsaved changes (isDirtyRef tracks every user-side edit).
  // Reset the canvas to the default blank layout (no dirty-confirm, no toast —
  // callers handle those). Shared by the "+ New" picker's Blank option and the
  // direct fallthrough paths.
  const applyBlankCanvas = useCallback(() => {
    seedSupersededRef.current = true;
    const order = ['logo','vehicle','msrp','options','subtotal','askbar','dealer','bgimage'];
    let nextNid = 1;
    let ws: Record<string, Widget> = {};
    order.forEach(type => {
      const id = 'w' + nextNid++;
      ws[id] = makeWidget(type, id);
    });
    if (vehicle) {
      Object.values(ws).forEach(w => {
        if (w.type === 'vehicle') w.d = { ...w.d, fields: ['stock','vin','year','color','make','trim','model'] };
      });
      ws = applyVehicleDataToWidgets(ws, vehicle);
    } else if (dealerInfoRef.current) {
      ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
    }
    ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
    ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
    widgetsRef.current = ws;
    setWidgets(ws);
    setNid(nextNid);
    setSelId(null);
    setTemplateName(vehicle ? `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'New Template' : 'New Template');
    setLoadedTemplateId(null);
    setLoadedTemplateLocked(false);
    setLoadedTemplateSource(null);
    // Fresh canvas: reset the group-toggle to the context default (dealer-scoped
    // once switched into a dealer; group-scoped at group level).
    setSaveAsGroupTemplate(Boolean(groupId) && !dealerId);
    setPaperSize('standard');
    paperSizeRef.current = 'standard';
    setBgUrl(BG_DEFAULT);
    setFontScale(1.0); // applyBlankCanvas
    // History is reset to this single baseline so undo can't reach the
    // previous template — that template is unrelated to the new one.
    setHistory([JSON.stringify({ widgets: ws, nid: nextNid })]);
    setHistIdx(0);
    isDirtyRef.current = false;
  }, [vehicle, groupId, dealerId]);

  // Truly-blank canvas (empty widgets). Distinct from applyBlankCanvas, which
  // — despite the name — seeds the standard widget set. Backs the explicit
  // "Blank" choice in the group-mode "+ New" picker (since 2026-08-12 the
  // group DEFAULT is the standard layout; empty is opt-in).
  const applyEmptyCanvas = useCallback(() => {
    seedSupersededRef.current = true;
    const ws: Record<string, Widget> = {};
    widgetsRef.current = ws;
    setWidgets(ws);
    setNid(1);
    setSelId(null);
    setTemplateName('New Template');
    setLoadedTemplateId(null);
    setLoadedTemplateLocked(false);
    setLoadedTemplateSource(null);
    setSaveAsGroupTemplate(Boolean(groupId) && !dealerId);
    setPaperSize('standard');
    paperSizeRef.current = 'standard';
    setBgUrl(BG_DEFAULT);
    setFontScale(1.0);
    setHistory([JSON.stringify({ widgets: ws, nid: 1 })]);
    setHistIdx(0);
    isDirtyRef.current = false;
  }, [groupId, dealerId]);

  // Clone a platform starter into a NEW, UNSAVED dealer document: load its
  // bg + widgets + paper + fontScale, but clear loadedTemplateId/locked so a
  // later Save creates the dealer's OWN template (POST /api/templates). The
  // starter row is never mutated. Mirrors loadTemplate's template_json handling.
  const loadStarterAsNew = useCallback(async (starterId: string) => {
    seedSupersededRef.current = true;
    try {
      const r = await fetch(`/api/starter-templates/${starterId}`);
      if (!r.ok) { showToast('Failed to load starter layout'); return; }
      const resp = await r.json();
      const tmpl = resp.data as { template_json?: Record<string, unknown>; name?: string; doc_type?: string; is_blank_default?: boolean } | null;
      const json = (tmpl?.template_json ?? {}) as { widgets?: Record<string, Widget>; nid?: number; bgUrl?: string; fontScale?: number; paperSize?: string };
      if (!json.widgets || Object.keys(json.widgets).length === 0) {
        // Blank default with an empty payload → fall back to the hardcoded set.
        if (tmpl?.is_blank_default) { applyBlankCanvas(); setShowNewPicker(false); return; }
        showToast('This starter has no saved layout.');
        return;
      }
      const psKey = json.paperSize ?? 'standard';
      const { w: pw, h: ph } = getPaperDims(psKey, customSizesRef.current);
      let ws = json.widgets;
      let n = json.nid ?? 1;
      ws = convertLegacyInfoboxes(ws);
      [ws, n] = ensureAskbar(ws, n, psKey);
      ws = clampWidgets(ws, pw, ph);
      if (vehicle) ws = applyVehicleDataToWidgets(ws, vehicle);
      else if (dealerInfoRef.current) ws = applyDealerInfoToWidgets(ws, dealerInfoRef.current);
      ws = applyLogoToWidgets(ws, canonicalLogoRef.current);
      ws = applyDisclaimerToWidgets(ws, disclaimersRef.current);
      setWidgets(ws); widgetsRef.current = ws;
      setNid(n);
      if (json.bgUrl) setBgUrl(json.bgUrl);
      setFontScale(typeof json.fontScale === 'number' ? json.fontScale : 1.0);
      setPaperSize(psKey); paperSizeRef.current = psKey;
      // NEW, UNSAVED doc — Save → POST /api/templates (dealer's own), or the
      // group-templates create path when authoring in group mode. Clearing the
      // loaded id/source keeps the group save logic (eef9e5a) in create mode
      // until the first Save; starters seed CONTENT only.
      setLoadedTemplateId(null);
      setLoadedTemplateLocked(false);
      setLoadedTemplateSource(null);
      setSaveAsGroupTemplate(Boolean(groupId) && !dealerId);
      // Pre-fill the Save modal's doc_type from the starter (dealer picker only
      // ever surfaces addendum/infosheet starters).
      const dt = tmpl?.doc_type;
      if (dt === 'addendum' || dt === 'infosheet') setSaveDocType(dt);
      // The Blank default seeds a fresh doc — don't carry its "Blank" name.
      setTemplateName(tmpl?.is_blank_default ? 'New Template' : (tmpl?.name || 'New Template'));
      setSelId(null);
      setHistory([JSON.stringify({ widgets: ws, nid: n })]);
      setHistIdx(0);
      isDirtyRef.current = false;
      setShowNewPicker(false);
      showToast(tmpl?.is_blank_default ? 'New document' : `Started from: ${tmpl?.name || 'starter'}`);
    } catch {
      showToast('Failed to load starter layout');
    }
  }, [showToast, vehicle, applyBlankCanvas, groupId, dealerId]);

  // "+ New" handler. super_admin starter-mode → new blank STARTER (unchanged).
  // Dealer → Blank(=standard) + platform starters; group → Standard Layout
  // (default) + truly-empty Blank + starters. Group always shows the picker.
  const newTemplate = useCallback(async () => {
    if (isDirtyRef.current) {
      if (!window.confirm('Start a new document?\n\nUnsaved changes will be lost.')) return;
    }
    if (starterMode) {
      applyBlankCanvas();
      showToast('New starter');
      return;
    }
    const groupMode = Boolean(groupId) && !dealerId;
    type SRow = { id: string; name: string; doc_type: string; is_blank_default?: boolean };
    let all: SRow[] = [];
    try {
      const r = await fetch('/api/starter-templates');
      if (r.ok) {
        const j = await r.json() as { data?: SRow[] };
        all = j.data ?? [];
      }
    } catch { /* ignore — fall through to Blank */ }
    // The blank-default starter backs the "Standard Layout" default (loaded
    // from the DB, hardcode fallback); it's not listed among the other
    // starters. Group mode additionally offers a truly-empty "Blank" choice.
    const blank = all.find(s => s.is_blank_default);
    const blankId = blank?.id ?? null;
    setBlankStarterId(blankId);
    // Builder doc types only — buyer's guides are a separate (PDF) flow and the
    // dealer templates API rejects them on save.
    const others = all.filter(s => !s.is_blank_default && (s.doc_type === 'addendum' || s.doc_type === 'infosheet'));
    if (others.length === 0 && !groupMode) {
      // Dealer mode with no starters — load the standard layout straight away.
      // Group mode always shows the picker (Standard vs Blank is a real choice).
      if (blankId) await loadStarterAsNew(blankId);
      else { applyBlankCanvas(); showToast('New document'); }
      return;
    }
    setStarterPickerList(others);
    setShowNewPicker(true);
  }, [applyBlankCanvas, applyEmptyCanvas, loadStarterAsNew, starterMode, showToast, groupId, dealerId]);

  // ── Selected widget ────────────────────────────────────────────────
  const sel = selId ? widgets[selId] : null;
  const effectiveDealerId = dealerId ?? vehicle?.dealer_id ?? null;

  // ── Zoom ───────────────────────────────────────────────────────────
  const doZoom = (d: number) => { setZ(z => { const next = Math.max(0.25, Math.min(2, z + d)); ZRef.current = next; return next; }); };

  // ────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────
  const ps = getPaperDims(paperSize, localCustomSizes);
  const isInfosheet = resolveIsInfosheet(paperSize, localCustomSizes);
  const usedTypes = new Set(Object.values(widgets).map(w => w.type));

  return (
    <div style={{ fontFamily: "'Roboto', -apple-system, sans-serif", display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontSize: 13, background: '#3a6897', color: '#333' }}>

      {/* Canvas-side CSS for HTML product descriptions — keep in sync with lib/pdf-html.ts */}
      <style jsx global>{`
        .description-html p { margin: 0; }
        .description-html p:empty { min-height: 1em; }
        .description-html ul { margin: 0; padding-left: 1.2em; list-style-type: disc; }
        .description-html ul ul { list-style-type: circle; padding-left: 1.2em; }
        .description-html ol { margin: 0; padding-left: 1.2em; }
        .description-html li { margin: 0; padding: 0; }
      `}</style>

      {/* TOPBAR */}
      <div style={{ height: 50, background: '#2a2b3c', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0, gap: 8 }}>
        {/* Left: canvas status */}
        <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#4caf50' }} />Canvas
        </div>

        {/* Right: controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Undo / Redo */}
          <Tb onClick={undo} title="Undo (⌘Z)">↩</Tb>
          <Tb onClick={redo} title="Redo (⌘⇧Z)">↪</Tb>
          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

          {/* Zoom */}
          <Tb onClick={() => doZoom(-0.05)}>−</Tb>
          <div
            style={{ fontSize: 11, fontFamily: 'monospace', color: '#333', padding: '3px 7px', background: 'rgba(255,255,255,0.9)', borderRadius: 4, border: '1px solid rgba(255,255,255,0.25)', minWidth: 40, textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
            onClick={() => { setZ(0.75); ZRef.current = 0.75; }}
            title="Reset zoom to 75%"
          >
            {Math.round(Z * 100)}%
          </div>
          <Tb onClick={() => doZoom(0.05)}>+</Tb>
          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

          {/* Paper size */}
          <select
            value={paperSize}
            onChange={e => {
              if (e.target.value === '__add_new__') {
                if (effectiveDealerId) setShowAddSizeModal(true);
              } else {
                switchPaperSize(e.target.value);
              }
            }}
            style={{ padding: '4px 6px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, fontSize: 11, fontFamily: 'inherit', background: 'rgba(255,255,255,0.9)', color: '#333', cursor: 'pointer', outline: 'none' }}>
            <option value="standard">4&#xBC;&#x2033; Addendum</option>
            <option value="narrow">3&#x215B;&#x2033; Addendum</option>
            <option value="wide">8&#xBD;&#x2033; Addendum</option>
            <option value="infosheet">8&#xBD;&#x2033; Infosheet</option>
            {localCustomSizes.length > 0 && <option disabled>────────────────</option>}
            {localCustomSizes.map(cs => (
              <option key={cs.id} value={cs.id}>{cs.name} ({cs.width_in}&quot; × {cs.height_in}&quot;)</option>
            ))}
            {canAddCustomSize && effectiveDealerId && (
              <option disabled>────────────────</option>
            )}
            {canAddCustomSize && effectiveDealerId && (
              <option value="__add_new__">+ Add Custom Size</option>
            )}
          </select>
          {canAddCustomSize && effectiveDealerId && (
            <button onClick={() => setShowCustomSizesModal(true)} title="Manage custom sizes"
              style={{ width: 26, height: 26, borderRadius: 4, border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.1)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 13, flexShrink: 0 }}>
              ⚙
            </button>
          )}

          {/* Font size */}
          <select value={fontScale} onChange={e => setFontScale(+e.target.value)}
            style={{ padding: '4px 6px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, fontSize: 11, fontFamily: 'inherit', background: 'rgba(255,255,255,0.9)', color: '#333', cursor: 'pointer', outline: 'none' }}>
            <option value="0.8">Font: Small</option>
            <option value="1.0">Font: Medium</option>
            <option value="1.2">Font: Large</option>
            <option value="1.4">Font: X-Large</option>
          </select>
          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

          {/* AI Regenerate (conditional) */}
          {vehicle && (usedTypes.has('description') || usedTypes.has('features')) && (
            <button
              onClick={() => fetchAiContent(true)}
              disabled={aiLoading}
              style={{ ...tbBtn, background: aiLoading ? 'rgba(255,255,255,0.08)' : 'rgba(25,118,210,0.85)', borderColor: '#1976d2', opacity: aiLoading ? 0.6 : 1 }}
            >
              {aiLoading ? '⟳ Generating…' : '✦ AI'}
            </button>
          )}
          {loadedTemplateId && (
            <span
              style={{ fontSize: 11, color: 'rgba(255,255,255,0.78)', whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 4px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title={`Editing ${templateName}${loadedTemplateSource === 'group' ? ' (group template)' : ''}`}
            >
              Editing: <strong style={{ color: '#fff', fontWeight: 600 }}>{templateName}</strong>
              {loadedTemplateSource === 'group' && (
                <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.03em', color: '#ffa500', border: '1px solid rgba(255,165,0,0.55)', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                  Group Template
                </span>
              )}
            </span>
          )}
          {/* Group-authoring mode with nothing loaded yet — still flag the
              context so a new document reads as a group template. */}
          {!loadedTemplateId && groupId && saveAsGroupTemplate && (
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.03em', color: '#ffa500', border: '1px solid rgba(255,165,0,0.55)', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap' }}>
              Group Template
            </span>
          )}
          {groupId && !dealerId && (
            <a
              href={`/groups/${groupId}`}
              style={{ ...tbBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
              title="Return to the group profile"
            >
              ← Back to Group
            </a>
          )}
          <button onClick={() => void newTemplate()} style={tbBtn} title={starterMode ? 'Start a new blank starter' : 'Start a new document — blank or from a starter layout'}>+ New</button>
          <button onClick={openTemplates} style={tbBtn}>All templates</button>
          <button
            onClick={async () => {
              if (loadedTemplateLocked) {
                showToast('Group templates cannot be saved — contact your group admin');
                return;
              }
              setSaveTname(templateName);
              setSaveDocType(resolveIsInfosheet(paperSize, localCustomSizes) ? 'infosheet' : 'addendum');
              try { const r = await fetch('/api/templates'); if (r.ok) { const j = await r.json(); setSavedTemplates(j.data ?? []); } } catch {}
              setShowSave(true);
            }}
            disabled={loadedTemplateLocked}
            title={loadedTemplateLocked ? 'Group templates cannot be saved — contact your group admin' : undefined}
            style={{
              ...tbBtn,
              background: loadedTemplateLocked ? 'rgba(255,255,255,0.08)' : '#1976d2',
              borderColor: loadedTemplateLocked ? '#555' : '#1976d2',
              cursor: loadedTemplateLocked ? 'not-allowed' : 'pointer',
              opacity: loadedTemplateLocked ? 0.55 : 1,
            }}
          >
            {loadedTemplateLocked ? '🔒 Locked' : 'Save template'}
          </button>
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
              {(['content','dynamic','suggested','infosheet','structural'] as const).map(group => {
                const tiles = PALETTE_TILES.filter(t => t.group === group);
                if (!tiles.length) return null;
                return (
                  <div key={group}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 0 5px' }}>
                      {group === 'infosheet' ? 'Infosheet'
                        : group === 'dynamic' ? 'Dynamic Content'
                        : group === 'content' ? 'Content'
                        : group === 'suggested' ? 'Suggested Products'
                        : 'Structural'}
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
                          onClick={() => {
                            if (!used) { addWidget(tile.type); return; }
                            // Single-instance widget already placed — select it on the canvas
                            const placed = Object.values(widgets).find(wg => wg.type === tile.type);
                            if (placed) {
                              setSelId(placed.id);
                              widgetEls.current.get(placed.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                            }
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 7,
                            padding: '7px 8px', border: '1px solid #e0e0e0', borderRadius: 4,
                            marginBottom: 3, cursor: used ? 'pointer' : 'grab',
                            background: '#fff', opacity: used ? 0.4 : 1,
                            filter: used ? 'grayscale(1)' : 'none',
                            transition: 'all .12s',
                          }}
                        >
                          <div style={{ width: 26, height: 26, borderRadius: 5, background: '#f0f4ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0 }}>{tile.emoji}</div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 500, color: '#333' }}>{tile.label}</div>
                            <div style={{ fontSize: 10, color: '#78828c', marginTop: 1 }}>{used ? 'Placed — click to select' : tile.hint}</div>
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
                    style={{ position: 'absolute', left: w.x, top: w.y, width: w.w, height: w.h, zIndex: w.z ?? 10, cursor: previewMode ? 'default' : 'move', userSelect: 'none', touchAction: 'none' }}
                    onPointerDown={e => startMove(e, w.id)}
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
                        onPointerDown={e => e.stopPropagation()}
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
                          touchAction: 'none',
                        }}
                        onPointerDown={e => startResize(e, w.id, dir)}
                      />
                    ))}
                    {/* Content. Suggested Products: real items exist only at
                        print time, so authoring injects SAMPLE items at render
                        time only — w.d and the saved template stay untouched,
                        and the PDF path (which always overwrites d.items from
                        real options, never sets sampleBadge) can't pick them
                        up. Lets authors see true content volume/overflow while
                        tuning box size + the label/products font pickers. */}
                    <div
                      style={{ width: '100%', height: '100%', overflow: 'visible' }}
                      dangerouslySetInnerHTML={{ __html: renderW(
                        w.type,
                        w.type === 'suggested_options' && (!Array.isArray(w.d.items) || (w.d.items as unknown[]).length === 0)
                          ? { ...w.d, items: SAMPLE_SUGGESTED_ITEMS, sampleBadge: true }
                          : w.d,
                        fontScale,
                      ) }}
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
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {/* Background panel — global canvas setting, sits above widget selection */}
              <EpSection>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontSize: 10, fontWeight: 600, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em' }}
                  onClick={() => setBgOpen(o => !o)}>
                  Background image <span>{bgOpen ? '▼' : '▶'}</span>
                </div>
                {bgOpen && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ border: '1px solid #e0e0e0', borderRadius: 6, marginBottom: 8 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', background: bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT ? '#e3f2fd' : '#fff', borderRadius: 6 }}
                        onClick={() => { setBgUrl(isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT); isDirtyRef.current = true; }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT} alt="" style={{ width: 18, height: 30, objectFit: 'cover', borderRadius: 2, flexShrink: 0, border: '1px solid #e0e0e0' }} />
                        <span style={{ fontSize: 11, flex: 1, color: bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT ? '#1976d2' : '#333', fontWeight: bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT ? 600 : 400 }}>Default</span>
                        {(bgUrl === BG_DEFAULT || bgUrl === IS_BG_DEFAULT) && <span style={{ color: '#1976d2', fontSize: 11, fontWeight: 700 }}>✓</span>}
                      </div>
                    </div>
                    <button onClick={() => setShowBgLibPicker(true)} style={{ width: '100%', padding: '6px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer', marginBottom: 6 }}>
                      Choose Background
                    </button>
                    {canAdminUpload && (
                      <>
                        <input
                          ref={canvasBgFileRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          style={{ display: 'none' }}
                          onChange={e => { const f = e.target.files?.[0]; if (f) void uploadCanvasBackground(f); }}
                        />
                        <button
                          onClick={() => canvasBgFileRef.current?.click()}
                          disabled={canvasBgUploading}
                          style={{ width: '100%', padding: '6px', background: canvasBgUploading ? '#9aa4ad' : '#f5f6f7', color: '#55595c', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 12, cursor: canvasBgUploading ? 'default' : 'pointer' }}
                        >
                          {canvasBgUploading ? 'Uploading…' : 'Upload background'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </EpSection>

              {/* Selected widget header — sits below Background, above widget-specific controls */}
              <div style={{ padding: '11px 13px 9px', borderTop: '1px solid #e0e0e0', borderBottom: '1px solid #e0e0e0' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>
                  {sel ? (WIDGET_LABELS[sel.type] || sel.type) : 'Canvas'}
                </div>
                <div style={{ fontSize: 11, color: '#78828c', marginTop: 1 }}>
                  {sel ? `${Math.round(sel.x)}, ${Math.round(sel.y)} · ${Math.round(sel.w)}×${Math.round(sel.h)}` : 'Click any widget to edit'}
                </div>
              </div>

              {/* Widget edit panel */}
              {sel ? (
                <WidgetEditPanel
                  widget={sel}
                  fontScale={fontScale}
                  dealerId={effectiveDealerId}
                  onUpdate={updateWidget}
                  onAdjFont={adjFont}
                  onDelete={deleteWidget}
                  onUpdatePos={updateWidgetPos}
                  onPickLogoImage={() => setShowLogoPicker(true)}
                  onLayerChange={handleLayerChange}
                  onPickInfolibImage={() => setShowInfoboxLibPicker(true)}
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

      {/* NEW DOCUMENT PICKER — Blank + platform starters (dealer/group Builder). */}
      {showNewPicker && (
        <Modal onClose={() => setShowNewPicker(false)} title="Start a new document">
          <div style={{ padding: '16px 24px 24px', maxHeight: 460, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, color: '#78828c', marginBottom: 12 }}>
              Start from a blank canvas or a platform starter layout. Picking a starter creates a new, editable document you save as your own.
            </div>
            {groupId && !dealerId && (
              // Group mode default (Allan decision 2026-08-12, reverses the
              // open-blank behavior): the base/standard layout leads the list,
              // highlighted as the default starting point.
              <button
                onClick={() => { if (blankStarterId) { void loadStarterAsNew(blankStarterId); } else { applyBlankCanvas(); setShowNewPicker(false); showToast('New document'); } }}
                style={{ width: '100%', textAlign: 'left', padding: '12px 14px', marginBottom: 8, border: '2px solid #1976d2', borderRadius: 6, background: '#f5f9ff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#2a2b3c' }}>Standard Layout</div>
                  <div style={{ fontSize: 12, color: '#78828c', marginTop: 2 }}>A ready starting point with the standard widgets (logo, vehicle, options, totals…).</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#1565c0', textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>Default</span>
              </button>
            )}
            <button
              onClick={() => {
                // Group mode: Blank = the truly-empty canvas, the explicit
                // start-from-nothing choice (the DEFAULT is Standard Layout).
                if (groupId && !dealerId) { applyEmptyCanvas(); setShowNewPicker(false); showToast('New document'); }
                else if (blankStarterId) { void loadStarterAsNew(blankStarterId); }
                else { applyBlankCanvas(); setShowNewPicker(false); showToast('New document'); }
              }}
              style={{ width: '100%', textAlign: 'left', padding: '12px 14px', marginBottom: 8, border: '1px solid #e0e0e0', borderRadius: 6, background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#2a2b3c' }}>Blank</div>
                <div style={{ fontSize: 12, color: '#78828c', marginTop: 2 }}>{groupId && !dealerId ? 'Empty canvas — add widgets yourself.' : 'Empty canvas with the default widgets.'}</div>
              </div>
            </button>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em', margin: '14px 0 6px' }}>Starter Layouts</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {starterPickerList.map(s => (
                <button key={s.id}
                  onClick={() => void loadStarterAsNew(s.id)}
                  style={{ width: '100%', textAlign: 'left', padding: '10px 14px', border: '1px solid #e0e0e0', borderRadius: 6, background: '#fff', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: '#333' }}>{s.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#1565c0', textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>
                    {s.doc_type === 'infosheet' ? 'Infosheet' : 'Addendum'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* SAVE TEMPLATE MODAL */}
      {showSave && (
        <Modal onClose={() => setShowSave(false)} title={starterMode ? 'Save Starter Layout' : 'Save Template'}>
          <div style={{ padding: '24px' }}>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#55595c', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 6 }}>{starterMode ? 'Starter Name' : 'Template Name'}</label>
              <input value={saveTname} onChange={e => setSaveTname(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid #e0e0e0', borderRadius: 6, fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                placeholder={starterMode ? 'e.g. Classic Addendum, Modern Infosheet' : 'e.g. Subaru Standard, Used Cars — Black V5'}
                autoFocus />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#55595c', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 6 }}>Document Type</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(starterMode
                  ? [['addendum', 'Addendum'], ['infosheet', 'Infosheet'], ['buyers_guide', "Buyer's Guide"]]
                  : [['addendum', 'Addendum'], ['infosheet', 'Infosheet']]).map(([dt, dl]) => (
                  <button key={dt} onClick={() => setSaveDocType(dt as 'addendum' | 'infosheet' | 'buyers_guide')}
                    style={{ padding: '7px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `2px solid ${saveDocType === dt ? '#1976d2' : '#e0e0e0'}`, background: saveDocType === dt ? '#1976d2' : '#fff', color: saveDocType === dt ? '#fff' : '#55595c', fontFamily: 'inherit' }}>
                    {dl}
                  </button>
                ))}
              </div>
            </div>
            {starterMode ? (
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#55595c', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 6 }}>Paper</label>
                <select value={paperSize} onChange={e => switchPaperSize(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e0e0e0', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', background: '#fff', boxSizing: 'border-box' }}>
                  {Object.keys(PAPERS).map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                  {localCustomSizes.map(cs => <option key={cs.id} value={`custom:${cs.id}`}>{cs.name}</option>)}
                </select>
              </div>
            ) : (
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
            )}
            <div style={{ background: '#f5f6f7', borderRadius: 6, padding: '12px 14px', fontSize: 12, color: '#55595c', lineHeight: 1.8 }}>
              <div><strong>{starterMode ? 'Starter' : 'Template'}:</strong> <span style={{ color: '#333' }}>{saveTname || templateName || '—'}</span></div>
              <div><strong>Document type:</strong> <span style={{ color: '#333' }}>{saveDocType === 'infosheet' ? 'Infosheet' : saveDocType === 'buyers_guide' ? "Buyer's Guide" : 'Addendum'}</span></div>
              <div><strong>Widgets:</strong> <span style={{ color: '#333' }}>{Object.keys(widgets).length} widgets</span></div>
              {starterMode
                ? <div><strong>Paper:</strong> <span style={{ color: '#333' }}>{paperSize}</span></div>
                : <div><strong>Applies to:</strong> <span style={{ color: '#1976d2', fontWeight: 600 }}>{Array.from(saveVtypes).map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(', ')}</span></div>}
            </div>
          </div>
          {groupId && (
            <div style={{ padding: '0 24px 20px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <div
                  onClick={() => setSaveAsGroupTemplate(v => !v)}
                  style={{
                    width: 36, height: 20, borderRadius: 10, background: saveAsGroupTemplate ? '#1976d2' : '#e0e0e0',
                    position: 'relative', transition: 'background 150ms', cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 2, left: saveAsGroupTemplate ? 18 : 2, width: 16, height: 16,
                    borderRadius: '50%', background: '#fff', transition: 'left 150ms',
                  }} />
                </div>
                <span style={{ fontSize: 13, color: '#333' }}>
                  Save as Group Template — shared with all dealers in your group
                </span>
              </label>
            </div>
          )}
          <div style={{ padding: '16px 24px', borderTop: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: '#78828c' }}>
              {starterMode ? 'Saving as a platform starter layout' : saveAsGroupTemplate && groupId ? 'Saving to group template library' : 'Templates saved per dealer'}
            </span>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={() => setShowSave(false)} style={mfClose}>Cancel</button>
              {/* Deliberate-duplicate path: only when editing an existing group
                  template. Creates "{name} v2" instead of overwriting. */}
              {saveAsGroupTemplate && groupId && loadedTemplateSource === 'group' && loadedTemplateId && (
                <button onClick={() => saveTemplate(true)} style={mfClose}>Save as new copy</button>
              )}
              <button onClick={() => saveTemplate()} style={mfSave}>Save Template</button>
            </div>
          </div>
        </Modal>
      )}

      {/* OPEN TEMPLATES MODAL */}
      {showOpenModal && (
        <Modal onClose={() => setShowOpenModal(false)} title="Open Template">
          <div style={{ padding: '16px 24px', maxHeight: 400, overflowY: 'auto' }}>
            {savedTemplates.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#78828c', padding: 24, fontSize: 13 }}>
                {groupId && !dealerId
                  ? 'No group templates yet — start from a starter layout below or a blank canvas.'
                  : 'No saved templates yet.'}
              </div>
            ) : savedTemplates.map(t => {
              const isDefault = defaultTemplateIds.has(t.id);
              const isConfirming = deleteConfirmId === t.id;
              const isGroupLocked = t.source === 'group' && t.is_locked !== false;
              const isGroupEditable = t.source === 'group' && t.is_locked === false;
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #e0e0e0', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#333', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {t.name}
                      {isGroupLocked && (
                        <span title="Group template — load and print only; cannot save changes" style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10, background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80' }}>🔒 Group</span>
                      )}
                      {isGroupEditable && (
                        <span title="Group template assigned to you — editable copy" style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10, background: '#e3f2fd', color: '#1565c0', border: '1px solid #bbdefb' }}>Group</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#78828c', marginTop: 2 }}>{t.document_type} · {t.vehicle_types?.join(', ')}</div>
                  </div>
                  {isConfirming ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <span style={{ fontSize: 11, color: '#555' }}>Delete &ldquo;{t.name}&rdquo;? This cannot be undone.</span>
                      <button onClick={async () => {
                        const delUrl = groupId ? `/api/group-templates/${groupId}/${t.id}` : `/api/templates/${t.id}`;
                        const r = await fetch(delUrl, { method: 'DELETE' });
                        if (r.ok || r.status === 204) {
                          setSavedTemplates(prev => prev.filter(x => x.id !== t.id));
                          setDefaultTemplateIds(prev => { const n = new Set(prev); n.delete(t.id); return n; });
                        }
                        setDeleteConfirmId(null);
                      }} style={{ padding: '4px 10px', background: '#ff5252', color: '#fff', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>Confirm</button>
                      <button onClick={() => setDeleteConfirmId(null)} style={{ padding: '4px 10px', background: '#f5f6f7', color: '#333', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button onClick={() => loadTemplate(t.id)} style={{ padding: '5px 12px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>Load</button>
                      {/* Copy — native rows only: dealer templates in dealer mode,
                          group templates in group mode. Group-sourced rows in the
                          dealer modal are managed by the group (assign modal owns
                          "dealer can edit" copies); starter rows have Start from. */}
                      {!starterMode && t.source !== 'group' && (
                        <button onClick={() => void copyTemplate(t)} disabled={copyingId === t.id}
                          title="Duplicate this template as an independent copy"
                          style={{ padding: '5px 10px', background: '#fff', color: '#1976d2', border: '1px solid #1976d2', borderRadius: 4, fontSize: 12, cursor: copyingId === t.id ? 'default' : 'pointer', fontFamily: 'inherit', opacity: copyingId === t.id ? 0.6 : 1, flexShrink: 0 }}>
                          {copyingId === t.id ? 'Copying…' : 'Copy'}
                        </button>
                      )}
                      {isGroupLocked ? (
                        // Locked group templates: dealer never deletes — group admin manages.
                        <span title="Locked group template — managed by your group admin" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 4, border: '1px solid #e0e0e0', background: '#f5f6f7', cursor: 'not-allowed', color: '#ccc', flexShrink: 0 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </span>
                      ) : isDefault ? (
                        <span title="Cannot delete — assigned as a default template" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 4, border: '1px solid #e0e0e0', background: '#f5f6f7', cursor: 'not-allowed', color: '#ccc', flexShrink: 0 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        </span>
                      ) : (
                        <button onClick={() => setDeleteConfirmId(t.id)} title="Delete template" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 4, border: '1px solid #e0e0e0', background: '#fff', cursor: 'pointer', color: '#ff5252', flexShrink: 0 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Group mode: platform Starter Layouts below the group's templates.
                Picking one seeds a NEW unsaved group template (content only). */}
            {groupId && !dealerId && (starterPickerList.length > 0 || blankStarterId) && (
              <div style={{ marginTop: savedTemplates.length > 0 ? 16 : 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#78828c', textTransform: 'uppercase', letterSpacing: '.05em', margin: '4px 0 6px' }}>Starter Layouts</div>
                {blankStarterId && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#333' }}>Standard Layout</div>
                      <div style={{ fontSize: 11, color: '#78828c', marginTop: 2 }}>The platform&rsquo;s base widget set</div>
                    </div>
                    <button
                      onClick={() => { setShowOpenModal(false); void loadStarterAsNew(blankStarterId); }}
                      style={{ padding: '5px 12px', background: '#fff', color: '#1976d2', border: '1px solid #1976d2', borderRadius: 4, fontSize: 12, cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}>
                      Start from
                    </button>
                  </div>
                )}
                {starterPickerList.map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#333' }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: '#78828c', marginTop: 2 }}>{s.doc_type === 'infosheet' ? 'Infosheet' : 'Addendum'} · platform starter</div>
                    </div>
                    <button
                      onClick={() => { setShowOpenModal(false); void loadStarterAsNew(s.id); }}
                      style={{ padding: '5px 12px', background: '#fff', color: '#1976d2', border: '1px solid #1976d2', borderRadius: 4, fontSize: 12, cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}>
                      Start from
                    </button>
                  </div>
                ))}
              </div>
            )}
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

      {/* CUSTOM SIZES MODAL */}
      {showCustomSizesModal && effectiveDealerId && (
        <CustomSizesModal
          dealerId={effectiveDealerId}
          initialSizes={localCustomSizes}
          onUpdate={sizes => {
            setLocalCustomSizes(sizes);
            customSizesRef.current = sizes;
          }}
          onClose={() => setShowCustomSizesModal(false)}
        />
      )}

      {/* ADD CUSTOM SIZE MODAL */}
      {showAddSizeModal && effectiveDealerId && (
        <AddCustomSizeModal
          dealerId={effectiveDealerId}
          onSave={newSize => {
            const updated = [...customSizesRef.current, newSize];
            setLocalCustomSizes(updated);
            customSizesRef.current = updated;
            setShowAddSizeModal(false);
            switchPaperSize(newSize.id);
          }}
          onClose={() => setShowAddSizeModal(false)}
        />
      )}

      {/* LOGO IMAGE PICKER */}
      {showLogoPicker && (
        <ImageUploadPicker
          title="Choose Logo Image"
          tab1Label="My Logos"
          listEndpoint={`/api/upload-image?bucket=new-dealer-logos${effectiveDealerId ? `&prefix=${encodeURIComponent(effectiveDealerId)}` : ''}`}
          uploadBucket="new-dealer-logos"
          uploadKeyPrefix={effectiveDealerId ?? ''}
          acceptedTypes="image/png,image/jpeg,image/jpg,image/svg+xml"
          maxSizeMB={2}
          onSelect={url => {
            if (selId) updateWidget(selId, 'imgUrl', url);
            setShowLogoPicker(false);
          }}
          onClose={() => setShowLogoPicker(false)}
        />
      )}

      {/* BACKGROUND IMAGE LIBRARY PICKER (also serves legacy infobox) */}
      {showInfoboxLibPicker && (
        <ImagePickerModal
          bucket="new-infobox-images"
          title="Choose Custom Image"
          onSelect={url => {
            if (selId) {
              const selected = widgetsRef.current[selId];
              // Old legacy infobox still flips ibType=upload + imgUrl.
              // New bgimage widget just sets imgUrl.
              if (selected?.type === 'infobox') {
                updateWidget(selId, 'ibType', 'upload');
              }
              updateWidget(selId, 'imgUrl', url);
            }
            setShowInfoboxLibPicker(false);
          }}
          onClose={() => setShowInfoboxLibPicker(false)}
        />
      )}

      {/* BACKGROUND LIBRARY PICKER */}
      {showBgLibPicker && (
        <ImagePickerModal
          bucket={isInfosheet ? 'new-infosheet-backgrounds' : 'new-addendum-backgrounds'}
          title="Platform Backgrounds"
          onSelect={url => {
            setBgUrl(url);
            isDirtyRef.current = true;
            setShowBgLibPicker(false);
          }}
          onClose={() => setShowBgLibPicker(false)}
        />
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
function WidgetEditPanel({ widget: w, fontScale, dealerId, onUpdate, onAdjFont, onDelete, onUpdatePos, onPickLogoImage, onLayerChange, onPickInfolibImage }: {
  widget: Widget;
  fontScale: number;
  dealerId: string | null;
  onUpdate: (id: string, key: string, value: unknown) => void;
  onAdjFont: (id: string, key: string, delta: number) => void;
  onDelete: (id: string) => void;
  onUpdatePos: (id: string, key: 'x'|'y'|'w'|'h', value: number) => void;
  onPickLogoImage?: () => void;
  onLayerChange?: (id: string, action: 'front'|'back'|'forward'|'backward') => void;
  onPickInfolibImage?: () => void;
}) {
  const d = w.d;
  const u = (key: string, val: unknown) => onUpdate(w.id, key, val);

  const [qrSavingDefault, setQrSavingDefault] = useState(false);
  const [qrDefaultSaved, setQrDefaultSaved] = useState(false);
  // BG Image upload state — used by the bgimage property panel
  const bgUploadRef = useRef<HTMLInputElement>(null);
  const [bgUploading, setBgUploading] = useState(false);
  const [bgUploadError, setBgUploadError] = useState<string | null>(null);
  async function handleBgUpload(file: File) {
    setBgUploading(true);
    setBgUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('bucket', 'new-infobox-images');
      fd.append('keyPrefix', dealerId ?? 'shared');
      const res = await fetch('/api/upload-image', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: 'Upload failed' }));
        setBgUploadError(j.error ?? 'Upload failed');
        return;
      }
      const { url } = await res.json() as { url: string };
      u('imgUrl', url);
    } catch (e) {
      setBgUploadError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBgUploading(false);
    }
  }

  async function saveQrDefault() {
    if (!dealerId) return;
    const tmpl = (d.qrUrlTemplate as string) || '';
    setQrSavingDefault(true);
    try {
      await fetch(`/api/settings?dealer_id=${encodeURIComponent(dealerId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_url_template: tmpl || null }),
      });
      setQrDefaultSaved(true);
      setTimeout(() => setQrDefaultSaved(false), 2000);
    } catch { /* ignore */ } finally {
      setQrSavingDefault(false);
    }
  }
  const af = (key: string, delta: number) => onAdjFont(w.id, key, delta);
  const fp = (key: 'x'|'y'|'w'|'h', val: number) => onUpdatePos(w.id, key, val);

  return (
    <>
      {/* === Widget-specific settings === */}
      {w.type === 'logo' && (
        <EpSection>
          <Eps>Logo</Eps>
          <Fd label="Logo Image">
            <button onClick={onPickLogoImage} style={{ padding: '5px 10px', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 11, background: '#f5f6f7', cursor: 'pointer', whiteSpace: 'nowrap', color: '#55595c' }}>
              Choose
            </button>
            {(d.imgUrl as string) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.imgUrl as string} alt="" style={{ maxWidth: '100%', maxHeight: 40, objectFit: 'contain', border: '1px solid #e0e0e0', borderRadius: 2, marginTop: 6, display: 'block' }} />
            )}
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
        </EpSection>
      )}

      {w.type === 'msrp' && (
        <EpSection>
          <Eps>MSRP Line</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontSize: 11, color: '#55595c' }}>Divider line above</span>
            <TogSwitch checked={!!d.dividerAbove} onChange={v => u('dividerAbove', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontSize: 11, color: '#55595c' }}>Divider line below</span>
            <TogSwitch checked={d.divider !== false} onChange={v => u('divider', v)} />
          </div>
        </EpSection>
      )}

      {w.type === 'retail_wholesale' && (
        <EpSection>
          <Eps>Retail / Wholesale</Eps>
          <Fd label="Line 1 label (struck-through retail)"><input value={(d.label1 as string) ?? 'Retail Price'} onChange={e => u('label1', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Line 2 label"><input value={(d.label2 as string) ?? 'Wholesale to the Public'} onChange={e => u('label2', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Second price">
            <div style={{ display: 'flex', gap: 6 }}>
              {([['percent', 'MSRP − %'], ['dollars', 'MSRP − $'], ['ask', 'Ask at print']] as const).map(([v, lbl]) => {
                const on = ((d.mode as string) || 'percent') === v;
                return (
                  <button type="button" key={v} onClick={() => u('mode', v)}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, border: `2px solid ${on ? '#1976d2' : '#e0e0e0'}`, background: on ? '#e3f2fd' : '#fff', color: on ? '#1976d2' : '#55595c' }}>
                    {lbl}
                  </button>
                );
              })}
            </div>
          </Fd>
          {((d.mode as string) || 'percent') === 'percent' && (
            <Fd label="Percent off MSRP">
              <input type="number" min={0} max={100} step={0.5} value={(d.percentOff as number) ?? 10}
                onChange={e => u('percentOff', Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)))} style={{ ...fiStyle, width: 120 }} />
            </Fd>
          )}
          {(d.mode as string) === 'dollars' && (
            <Fd label="Dollars off MSRP">
              <input type="number" min={0} value={(d.dollarsOff as number) ?? 1000}
                onChange={e => u('dollarsOff', Math.max(0, parseInt(e.target.value, 10) || 0))} style={{ ...fiStyle, width: 140 }} />
            </Fd>
          )}
          {(d.mode as string) === 'ask' && (
            <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 2 }}>
              Print Now asks for the price before generating. Bulk print and the mobile app can&apos;t prompt — they print a plain retail line (no strikethrough). The entered price is never saved to the vehicle.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontSize: 11, color: '#55595c' }}>Divider line above</span>
            <TogSwitch checked={!!d.dividerAbove} onChange={v => u('dividerAbove', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontSize: 11, color: '#55595c' }}>Divider line below</span>
            <TogSwitch checked={d.divider !== false} onChange={v => u('divider', v)} />
          </div>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Display-only — does not change subtotal or asking-price math. Second price rounds to the nearest dollar.</div>
        </EpSection>
      )}

      {w.type === 'options' && (
        <EpSection>
          <Eps>Required Products Table</Eps>
          <Fd label="Section label"><input value={(d.sectionLabel as string) || ''} onChange={e => u('sectionLabel', e.target.value)} style={fiStyle} /></Fd>
          {/* Section-label style parity with Suggested Products (2026-08-13):
              a background color turns the label into the same bold header box;
              "None" keeps the classic plain gray label — the default for every
              existing template (no saved options widget carries bgColor). */}
          <Fd label="Label Background">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <button type="button" onClick={() => { u('bgColor', ''); }}
                title="Plain label (no header box)"
                style={{ height: 22, padding: '0 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${!(d.bgColor as string) ? '#1976d2' : '#e0e0e0'}`, background: !(d.bgColor as string) ? '#e3f2fd' : '#fff', color: !(d.bgColor as string) ? '#1976d2' : '#55595c' }}>
                None
              </button>
              <ColorSwatches value={(d.bgColor as string) || ''} onChange={v => u('bgColor', v)} />
            </div>
          </Fd>
          {Boolean(d.bgColor) && (
            <Fd label="Text Color">
              <ColorSwatches value={(d.textColor as string) || '#ffffff'} onChange={v => u('textColor', v)} />
            </Fd>
          )}
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>
            {d.bgColor ? 'The section label sits bold on the colored box — same treatment as the Suggested Products header.' : 'Shows dealer-installed Required options only. Option names and prices are set per vehicle in the addendum editor.'}
          </div>
        </EpSection>
      )}

      {w.type === 'suggested_options' && (
        <EpSection>
          <Eps>Suggested Products Table</Eps>
          <Fd label="Section label"><input value={(d.sectionLabel as string) || ''} onChange={e => u('sectionLabel', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Background Color">
            <ColorSwatches value={(d.bgColor as string) || '#000000'} onChange={v => u('bgColor', v)} />
          </Fd>
          <Fd label="Text Color">
            <ColorSwatches value={(d.textColor as string) || '#ffffff'} onChange={v => u('textColor', v)} />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>The header label sits on the colored box; the product list prints below it. Clear the label to remove the bar entirely.</div>
        </EpSection>
      )}

      {w.type === 'suggested_price' && (
        <EpSection>
          <Eps>Suggested Price Bar</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Displays MSRP + all options (required + suggested). Updates automatically at print time.</div>
          <Fd label="Bar Color">
            <ColorPair value={(d.barColor as string) || '#000000'} onChange={v => u('barColor', v)} />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Two-tone bar: the price box uses the inverse color automatically.</div>
        </EpSection>
      )}

      {w.type === 'subtotal' && (
        <EpSection>
          <Eps>Subtotal</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
        </EpSection>
      )}

      {w.type === 'askbar' && (
        <EpSection>
          <Eps>Asking Price Bar</Eps>
          <Fd label="Label"><input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Subtitle (optional)"><input value={(d.subtitle as string) || ''} onChange={e => u('subtitle', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Symbol after price (optional)"><input value={(d.priceSuffix as string) || ''} maxLength={3} placeholder="e.g. *" onChange={e => u('priceSuffix', e.target.value)} style={fiStyle} /></Fd>
          <Fd label="Bar Color">
            <ColorPair value={(d.barColor as string) || '#000000'} onChange={v => u('barColor', v)} />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Two-tone bar: the price box uses the inverse color automatically. A subtitle prints below the bar in the bar color.</div>
        </EpSection>
      )}

      {w.type === 'dealer' && (
        <EpSection>
          <Eps>Dealer Address</Eps>
          {/* Address is profile-sourced — every load path re-derives it, so it's not editable here */}
          {(d.text as string) ? (
            <div style={{ ...fiStyle, padding: '7px 9px', whiteSpace: 'pre-wrap', color: '#555', background: '#f7f8fa', cursor: 'default' }}>
              {(d.text as string)}
            </div>
          ) : null}
          <div style={{ fontSize: 10, color: '#78828c', marginTop: 6, lineHeight: 1.5 }}>
            {(d.text as string)
              ? <>Address comes from your profile — edit it in <a href="/profile" style={{ color: '#1976d2' }}>My Profile</a>.</>
              : <>No address on file — add it in <a href="/profile" style={{ color: '#1976d2' }}>My Profile</a>.</>}
          </div>
          <Fd label="Alignment" style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 2 }}>
              {(['left','center','right'] as const).map(a => (
                <button key={a} onClick={() => u('textAlign', a)}
                  style={{ flex: 1, height: 28, border: `1px solid ${(d.textAlign as string || 'left') === a ? '#1976d2' : '#e0e0e0'}`, borderRadius: 4, background: (d.textAlign as string || 'left') === a ? '#e3f2fd' : '#fff', cursor: 'pointer', fontSize: 11, color: (d.textAlign as string || 'left') === a ? '#1976d2' : '#555', fontWeight: 600 }}>
                  {a === 'left' ? '≡L' : a === 'center' ? '≡C' : '≡R'}
                </button>
              ))}
            </div>
          </Fd>
        </EpSection>
      )}

      {w.type === 'headerbar' && (
        <EpSection>
          <Eps>Header Bar</Eps>
          <Fd label="Text"><input value={(d.text as string) || ''} onChange={e => u('text', e.target.value)} style={fiStyle} /></Fd>
          <Eps style={{ marginTop: 8 }}>Color</Eps>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {[['#1a1916','Black'],['#898989','Gray'],['#2563EB','Blue'],['#DC2626','Red'],['#15803D','Green'],['#7C3AED','Purple'],['#D97706','Gold'],['#ffffff','White']].map(([c,n]) => (
              <div key={c} title={n} onClick={() => u('color', c)}
                style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer', border: `1.5px solid ${(d.color as string) === c ? '#1976d2' : (c === '#ffffff' ? '#ccc' : 'transparent')}`, boxShadow: (d.color as string) === c ? '0 0 0 2px rgba(37,99,235,.2)' : 'none' }} />
            ))}
          </div>
          <FontStepper label="Font size" fkey="fontSize" base={11} d={d} fontScale={fontScale} af={af} />
          <Eps style={{ marginTop: 8 }}>Font color</Eps>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {/* Auto = auto-contrast against the bar color (current default). */}
            <div title="Auto (contrast)" onClick={() => u('fontColor', '')}
              style={{ width: 22, height: 22, borderRadius: 4, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: '#55595c', border: `1.5px solid ${!d.fontColor ? '#1976d2' : '#ccc'}`, boxShadow: !d.fontColor ? '0 0 0 2px rgba(37,99,235,.2)' : 'none' }}>A</div>
            {[['#1a1916','Black'],['#898989','Gray'],['#2563EB','Blue'],['#DC2626','Red'],['#15803D','Green'],['#7C3AED','Purple'],['#D97706','Gold'],['#ffffff','White']].map(([c,n]) => (
              <div key={c} title={n} onClick={() => u('fontColor', c)}
                style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer', border: `1.5px solid ${(d.fontColor as string) === c ? '#1976d2' : (c === '#ffffff' ? '#ccc' : 'transparent')}`, boxShadow: (d.fontColor as string) === c ? '0 0 0 2px rgba(37,99,235,.2)' : 'none' }} />
            ))}
          </div>
        </EpSection>
      )}

      {w.type === 'divider' && (
        <EpSection>
          <Eps>Divider Line</Eps>
          <Eps style={{ marginTop: 4 }}>Thickness</Eps>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            {[1, 2, 3].map(px => {
              const active = (Number(d.thickness) || 1) === px;
              return (
                <button key={px} type="button" onClick={() => u('thickness', px)}
                  style={{ flex: 1, padding: '6px 0', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    border: `1.5px solid ${active ? '#1976d2' : '#e0e0e0'}`, background: active ? '#e3f2fd' : '#fff', color: active ? '#1976d2' : '#55595c' }}>
                  {px}px
                </button>
              );
            })}
          </div>
          <Eps style={{ marginTop: 8 }}>Color</Eps>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {[['#1a1916','Black'],['#898989','Gray'],['#2563EB','Blue'],['#1a237e','Dark Blue'],['#DC2626','Red'],['#15803D','Green'],['#9aa0a6','Light Gray'],['#ffffff','White']].map(([c,n]) => (
              <div key={c} title={n} onClick={() => u('color', c)}
                style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer', border: `1.5px solid ${(d.color as string) === c ? '#1976d2' : (c === '#ffffff' ? '#ccc' : 'transparent')}`, boxShadow: (d.color as string) === c ? '0 0 0 2px rgba(37,99,235,.2)' : 'none' }} />
            ))}
          </div>
          <Fd label="Top margin (px)" style={{ marginTop: 8 }}>
            <input type="number" min={0} max={48} value={(d.topMargin as number) ?? 0} onChange={e => u('topMargin', Math.max(0, +e.target.value))} style={{ ...fiStyle, width: '100%' }} />
          </Fd>
          <Fd label="Bottom margin (px)">
            <input type="number" min={0} max={48} value={(d.bottomMargin as number) ?? 0} onChange={e => u('bottomMargin', Math.max(0, +e.target.value))} style={{ ...fiStyle, width: '100%' }} />
          </Fd>
          <p style={{ fontSize: 11, color: '#78828c', marginTop: 8, marginBottom: 0 }}>Drag the widget edges on the canvas to set the line&apos;s width.</p>
        </EpSection>
      )}

      {w.type === 'watermark' && (() => {
        const mode = (d.mode as string) || 'none';
        const opacity = Math.min(0.5, Math.max(0.05, Number(d.opacity) || 0.15));
        const MODES: { val: string; label: string }[] = [
          { val: 'none', label: 'None' },
          { val: 'auto', label: 'Auto' },
          { val: 'fixed', label: 'Fixed' },
        ];
        return (
          <EpSection>
            <Eps>Watermark</Eps>
            <Eps style={{ marginTop: 4 }}>Mode</Eps>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              {MODES.map(m => {
                const active = mode === m.val;
                return (
                  <button key={m.val} type="button" onClick={() => u('mode', m.val)}
                    title={m.val === 'auto' ? 'Use the vehicle’s make to pick the logo at print time' : m.val === 'fixed' ? 'Always use the brand you choose below' : 'No watermark'}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                      border: `1.5px solid ${active ? '#1976d2' : '#e0e0e0'}`, background: active ? '#e3f2fd' : '#fff', color: active ? '#1976d2' : '#55595c' }}>
                    {m.label}
                  </button>
                );
              })}
            </div>
            {mode === 'auto' && (
              <p style={{ fontSize: 11, color: '#78828c', marginTop: 6, marginBottom: 0 }}>The brand logo is chosen from the vehicle’s make when the PDF is generated.</p>
            )}

            {mode === 'fixed' && (
              <>
                <Eps style={{ marginTop: 10 }}>Brand{d.brand ? <span style={{ fontWeight: 400, color: '#55595c' }}> — {d.brand as string}</span> : null}</Eps>
                {d.brand && (
                  <div style={{ marginTop: 6, marginBottom: 6, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f7f8fa', border: '1px solid #e0e0e0', borderRadius: 6 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={watermarkUrl(d.brand as string)} alt={d.brand as string} style={{ maxHeight: 52, maxWidth: '90%', objectFit: 'contain' }} />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 4, maxHeight: 220, overflowY: 'auto', padding: 2, border: '1px solid #eee', borderRadius: 6 }}>
                  {WATERMARK_BRANDS.map(b => {
                    const selected = d.brand === b;
                    return (
                      <button key={b} type="button" onClick={() => u('brand', b)} title={b}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '6px 2px', cursor: 'pointer',
                          border: `1.5px solid ${selected ? '#1976d2' : '#e8e8e8'}`, borderRadius: 6, background: selected ? '#e3f2fd' : '#fff' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={watermarkUrl(b)} alt={b} loading="lazy" style={{ height: 28, maxWidth: '100%', objectFit: 'contain' }} />
                        <span style={{ fontSize: 9, color: '#55595c', textAlign: 'center', lineHeight: 1.1 }}>{b}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {mode !== 'none' && (
              <>
                <Eps style={{ marginTop: 10 }}>Opacity</Eps>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <input type="range" min={5} max={50} step={1} value={Math.round(opacity * 100)}
                    onChange={e => u('opacity', +e.target.value / 100)} style={{ flex: 1 }} />
                  <span style={{ minWidth: 36, textAlign: 'right', fontSize: 12, fontFamily: 'monospace', color: '#1976d2' }}>{Math.round(opacity * 100)}%</span>
                </div>
              </>
            )}
          </EpSection>
        );
      })()}

      {w.type === 'customtext' && (() => {
        function insertToken(token: string) {
          const cur = (d.text as string) || '';
          // RichTextEditor is a contentEditable (tiptap); append the token to the
          // stored HTML — tiptap normalizes it into the doc and the operator can
          // reposition/format it. Tokens resolve at print time.
          u('text', cur ? `${cur} ${token}` : token);
        }
        return (
          <EpSection>
            <Eps>Custom Text</Eps>
            <RichTextEditor
              value={(d.text as string) || ''}
              onChange={html => u('text', html)}
              placeholder="Custom text — use the toolbar for bold, italic, underline, color, and size"
              minHeight={72}
              toolbarOpen={true}
            />
            <Fd label="Alignment" style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 2 }}>
                {(['left','center','right'] as const).map(a => {
                  const cur = (d.textAlign as string) || (d.align as string) || 'left';
                  return (
                    <button key={a} onClick={() => { u('textAlign', a); u('align', a); }}
                      style={{ flex: 1, height: 28, border: `1px solid ${cur === a ? '#1976d2' : '#e0e0e0'}`, borderRadius: 4, background: cur === a ? '#e3f2fd' : '#fff', cursor: 'pointer', fontSize: 11, color: cur === a ? '#1976d2' : '#555', fontWeight: 600 }}>
                      {a === 'left' ? '≡L' : a === 'center' ? '≡C' : '≡R'}
                    </button>
                  );
                })}
              </div>
            </Fd>
            <Eps style={{ marginTop: 10 }}>Populate From</Eps>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {([
                ['Vehicle Desc', '{{vehicle.description}}'],
                ['Options List', '{{vehicle.options}}'],
                ['AI Desc', '{{ai.description}}'],
                ['AI Features', '{{ai.features}}'],
              ] as [string, string][]).map(([label, token]) => (
                <button key={token} onClick={() => insertToken(token)}
                  style={{ padding: '4px 7px', border: '1px solid #e0e0e0', borderRadius: 4, background: '#f5f6f7', cursor: 'pointer', fontSize: 11, color: '#333', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                  + {label}
                </button>
              ))}
            </div>
            <Fd label="Insert token" style={{ marginTop: 6 }}>
              <select defaultValue="" onChange={e => { if (e.target.value) { insertToken(e.target.value); (e.target as HTMLSelectElement).value = ''; } }}
                style={{ ...fiStyle }}>
                <option value="" disabled>Insert token…</option>
                <optgroup label="Vehicle">
                  {([
                    ['vehicle.description','Description'],
                    ['vehicle.options','Options list'],
                    ['vehicle.year','Year'],
                    ['vehicle.make','Make'],
                    ['vehicle.model','Model'],
                    ['vehicle.trim','Trim'],
                    ['vehicle.vin','VIN'],
                    ['vehicle.stock','Stock #'],
                    ['vehicle.mileage','Mileage'],
                    ['vehicle.color','Color'],
                    ['vehicle.msrp','MSRP'],
                    ['vehicle.asking_price','Asking Price'],
                  ] as [string,string][]).map(([key, label]) => (
                    <option key={key} value={`{{${key}}}`}>{label}</option>
                  ))}
                </optgroup>
                <optgroup label="AI Content">
                  <option value="{{ai.description}}">AI Description</option>
                  <option value="{{ai.features}}">AI Features</option>
                </optgroup>
              </select>
            </Fd>
          </EpSection>
        );
      })()}

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
            <div key={v} onClick={() => { u('ibType', v); if (v === 'epa') u('imgUrl', IB_DEFAULT); else if (v !== 'upload') u('imgUrl', ''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: `1px solid ${(d.ibType as string) === v ? '#1976d2' : '#e0e0e0'}`, borderRadius: 6, cursor: 'pointer', marginBottom: 3, background: (d.ibType as string) === v ? '#e3f2fd' : '#fff' }}>
              <span style={{ fontSize: 11, fontWeight: (d.ibType as string) === v ? 600 : 500, color: (d.ibType as string) === v ? '#1976d2' : '#333' } as React.CSSProperties}>{l}</span>
            </div>
          ))}
          {onPickInfolibImage && (
            <button
              onClick={onPickInfolibImage}
              style={{ width: '100%', padding: '6px', background: '#fff', color: '#1976d2', border: '1px solid #1976d2', borderRadius: 4, fontSize: 11, cursor: 'pointer', marginTop: 8, marginBottom: 4, fontFamily: 'inherit' }}
            >
              Choose from Image Library
            </button>
          )}
          {(d.ibType as string) === 'qr' && (
            <>
              <Fd label="Custom URL template (optional)" style={{ marginTop: 8 }}>
                <input value={(d.qrUrlTemplate as string) || ''} onChange={e => u('qrUrlTemplate', e.target.value || null)}
                  style={{ ...fiStyle, fontSize: 11 }} placeholder="https://dealer.com/inventory/[VIN]" />
              </Fd>
              <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, marginTop: 4 }}>
                Use <code style={{ background: '#f5f6f7', padding: '1px 3px', borderRadius: 2 }}>[VIN]</code> or <code style={{ background: '#f5f6f7', padding: '1px 3px', borderRadius: 2 }}>[STOCK]</code> as variables. Leave blank to use VDP link from inventory data.
              </div>
              {dealerId && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => void saveQrDefault()}
                    disabled={qrSavingDefault}
                    style={{ fontSize: 10, padding: '3px 8px', height: 24, background: '#fff', border: '1px solid #c0c0c0', borderRadius: 3, color: '#55595c', cursor: qrSavingDefault ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
                  >
                    {qrSavingDefault ? 'Saving…' : qrDefaultSaved ? '✓ Saved as default' : 'Use as default QR URL for all addenda'}
                  </button>
                </div>
              )}
            </>
          )}
          {(d.ibType as string) === 'upload' && (
            <Fd label="Image URL" style={{ marginTop: 8 }}>
              <input value={(d.imgUrl as string) || ''} onChange={e => u('imgUrl', e.target.value)} style={{ ...fiStyle, fontSize: 11 }} placeholder="https://…" />
            </Fd>
          )}
          {!['qr','upload'].includes((d.ibType as string) || '') && (
            <Fd label="Or load from URL" style={{ marginTop: 8 }}>
              <input value={(d.imgUrl as string) || ''} onChange={e => u('imgUrl', e.target.value)} style={{ ...fiStyle, fontSize: 11 }} placeholder="https://…" />
            </Fd>
          )}
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
        </EpSection>
      )}

      {w.type === 'features' && (
        <EpSection>
          <Eps>Features List</Eps>
          <AiSourceToggle value={(d.aiMode as string) || 'db'} onChange={v => u('aiMode', v)} />
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, padding: '4px 0' }}>
            {d.aiMode === 'ai' ? 'Claude generates features list at print time. Items shown are a preview.' : 'Features pulled from vehicle equipment database. 2-column layout auto-formatted.'}
          </div>
        </EpSection>
      )}

      {w.type === 'mpg' && (
        <EpSection>
          <Eps>MPG</Eps>
          <Fd label="Order">
            <div style={{ display: 'flex', gap: 4 }}>
              {([['city_first', 'City first'], ['hwy_first', 'Highway first']] as const).map(([val, lbl]) => (
                <button key={val} type="button" onClick={() => u('order', val)}
                  style={{ flex: 1, padding: '5px', borderRadius: 4, border: `2px solid ${((d.order as string) || 'city_first') === val ? '#1976d2' : '#e0e0e0'}`, background: ((d.order as string) || 'city_first') === val ? '#e3f2fd' : '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: ((d.order as string) || 'city_first') === val ? '#1976d2' : '#55595c', fontFamily: 'inherit' }}>
                  {lbl}
                </button>
              ))}
            </div>
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, padding: '4px 0' }}>
            Renders the vehicle&apos;s City + Highway MPG (no labels — the background graphic supplies them). A number is skipped when missing.
          </div>
        </EpSection>
      )}

      {w.type === 'barcode' && (
        <EpSection>
          <Eps>VIN Barcode</Eps>
          <Fd label="VIN (auto-populated at print time)">
            <input value={(d.vin as string) || ''} onChange={e => u('vin', e.target.value)} style={{ ...fiStyle, fontFamily: 'monospace', fontSize: 12 }} placeholder="VIN auto-filled from vehicle record" />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Code-128 barcode generated at print time via JsBarcode.</div>
        </EpSection>
      )}

      {w.type === 'qrcode' && (
        <EpSection>
          <Eps>QR Code</Eps>
          <Fd label="Custom URL template (optional)">
            <input value={(d.qrUrlTemplate as string) || ''} onChange={e => u('qrUrlTemplate', e.target.value || null)}
              style={{ ...fiStyle, fontSize: 11 }} placeholder="https://dealer.com/inventory/[VIN]" />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, marginTop: 4 }}>
            Use <code style={{ background: '#f5f6f7', padding: '1px 3px', borderRadius: 2 }}>[VIN]</code> or <code style={{ background: '#f5f6f7', padding: '1px 3px', borderRadius: 2 }}>[STOCK]</code> as variables. Leave blank to use VDP link from inventory data.
          </div>
          {dealerId && (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => void saveQrDefault()}
                disabled={qrSavingDefault}
                style={{ fontSize: 10, padding: '3px 8px', height: 24, background: '#fff', border: '1px solid #c0c0c0', borderRadius: 3, color: '#55595c', cursor: qrSavingDefault ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
              >
                {qrSavingDefault ? 'Saving…' : qrDefaultSaved ? '✓ Saved as default' : 'Use as default QR URL for all addenda'}
              </button>
            </div>
          )}
          <Fd label="Label" style={{ marginTop: 8 }}>
            <input value={(d.label as string) || ''} onChange={e => u('label', e.target.value)} style={fiStyle} />
          </Fd>
          <Fd label="Fallback URL" style={{ marginTop: 8 }}>
            <input value={(d.url as string) || ''} onChange={e => u('url', e.target.value)} style={{ ...fiStyle, fontSize: 11 }} placeholder="https://…" />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Used when VDP link and template are both empty.</div>
        </EpSection>
      )}

      {w.type === 'bgimage' && (
        <EpSection>
          <Eps>Custom Image</Eps>
          {onPickInfolibImage && (
            <button
              onClick={onPickInfolibImage}
              style={{ width: '100%', padding: '6px', background: '#fff', color: '#1976d2', border: '1px solid #1976d2', borderRadius: 4, fontSize: 11, cursor: 'pointer', marginBottom: 6, fontFamily: 'inherit' }}
            >
              Choose from Image Library
            </button>
          )}
          <button
            onClick={() => bgUploadRef.current?.click()}
            disabled={bgUploading}
            style={{ width: '100%', padding: '6px', background: bgUploading ? '#f5f6f7' : '#fff', color: '#1976d2', border: '1px dashed #1976d2', borderRadius: 4, fontSize: 11, cursor: bgUploading ? 'wait' : 'pointer', marginBottom: 4, fontFamily: 'inherit' }}
          >
            {bgUploading ? 'Uploading…' : 'Upload Image'}
          </button>
          <input
            ref={bgUploadRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handleBgUpload(f);
              e.target.value = '';
            }}
          />
          {bgUploadError && (
            <div style={{ fontSize: 10, color: '#ff5252', lineHeight: 1.5, paddingTop: 2 }}>{bgUploadError}</div>
          )}
          <Fd label="Or load from URL" style={{ marginTop: 8 }}>
            <input value={(d.imgUrl as string) || ''} onChange={e => u('imgUrl', e.target.value)} style={{ ...fiStyle, fontSize: 11 }} placeholder="https://…" />
          </Fd>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>Full-width image layer. PNG/JPG/WebP/GIF/SVG up to 5 MB. Use Layer Order below to control stacking.</div>
        </EpSection>
      )}

      {w.type === 'vehiclephoto' && (
        <EpSection>
          <Eps>Vehicle Photo</Eps>
          <div style={{ fontSize: 10, color: '#78828c', lineHeight: 1.5, paddingTop: 4 }}>
            Color-matched photo from ChromeData. URL is resolved at print time
            from the vehicle&apos;s VIN and exterior color — no setup needed.
          </div>
          <Fd label="Angle" style={{ marginTop: 8 }}>
            <select value={(d.angle as string) || '03'} onChange={e => u('angle', e.target.value)} style={fiStyle as React.CSSProperties}>
              <option value="03">03 — Driver-side profile (default)</option>
              <option value="01">01 — Front 3/4 driver</option>
              <option value="05">05 — Rear 3/4 driver</option>
              <option value="07">07 — Front 3/4 passenger</option>
            </select>
          </Fd>
        </EpSection>
      )}

      {/* === Font Size === */}
      {w.type === 'vehicle' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Header font size" fkey="headerFontSize" base={14} d={d} fontScale={fontScale} af={af} />
          <FontStepper label="Detail font size" fkey="fontSize" base={10} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'msrp' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Font size" fkey="fontSize" base={11} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'options' && (() => {
        // Split pickers (2026-08-10, mirrors suggested_options 2026-08-04):
        // Section Label vs Products. Both seed from the legacy single
        // fontSize so an old template's steppers show — and adjust from —
        // the value it actually renders with; the first click writes the new
        // key (renderer falls back until then, so nothing shifts until the
        // user changes it).
        const legacyMult = (d.fontSize as number) || 1.0;
        const dSeeded = {
          ...d,
          labelFontSize: (d.labelFontSize as number) ?? legacyMult,
          productsFontSize: (d.productsFontSize as number) ?? legacyMult,
        };
        const afSeeded = (key: string, delta: number) => {
          const cur = (d[key] as number) ?? legacyMult;
          u(key, Math.round(Math.max(0.5, Math.min(3.0, cur + delta)) * 10) / 10);
        };
        return (
          <EpSection>
            <Eps>Font Size</Eps>
            <FontStepper label="Section label font size" fkey="labelFontSize" base={10.5} d={dSeeded} fontScale={fontScale} af={afSeeded} />
            <FontStepper label="Products font size" fkey="productsFontSize" base={10.5} d={dSeeded} fontScale={fontScale} af={afSeeded} />
          </EpSection>
        );
      })()}
      {w.type === 'retail_wholesale' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Font size" fkey="fontSize" base={11} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'suggested_options' && (() => {
        // Split pickers (2026-08-04): Section Label (header bar) vs Products
        // (item rows). Both seed from the legacy single fontSize so an old
        // template's steppers show — and adjust from — the value it actually
        // renders with; the first click writes the new key (renderer falls
        // back until then, so nothing shifts until the user changes it).
        const legacyMult = (d.fontSize as number) || 1.0;
        const dSeeded = {
          ...d,
          labelFontSize: (d.labelFontSize as number) ?? legacyMult,
          productsFontSize: (d.productsFontSize as number) ?? legacyMult,
        };
        const afSeeded = (key: string, delta: number) => {
          const cur = (d[key] as number) ?? legacyMult;
          u(key, Math.round(Math.max(0.5, Math.min(3.0, cur + delta)) * 10) / 10);
        };
        return (
          <EpSection>
            <Eps>Font Size</Eps>
            <FontStepper label="Section label font size" fkey="labelFontSize" base={10.5} d={dSeeded} fontScale={fontScale} af={afSeeded} />
            <FontStepper label="Products font size" fkey="productsFontSize" base={10.5} d={dSeeded} fontScale={fontScale} af={afSeeded} />
          </EpSection>
        );
      })()}
      {w.type === 'suggested_price' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Label font size" fkey="labelFontSize" base={12} d={d} fontScale={fontScale} af={af} />
          <FontStepper label="Price font size" fkey="valueFontSize" base={13} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'subtotal' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Font size" fkey="fontSize" base={12} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'askbar' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Label font size" fkey="labelFontSize" base={12} d={d} fontScale={fontScale} af={af} />
          <FontStepper label="Price font size" fkey="valueFontSize" base={13} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'dealer' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Font size" fkey="fontSize" base={10} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'customtext' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <Fd label="Font size">
            <input type="number" value={(d.fs as number) || 10} min={7} max={24} onChange={e => u('fs', +e.target.value)} style={fiStyle} />
          </Fd>
        </EpSection>
      )}
      {w.type === 'description' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Font size" fkey="fontSize" base={10} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'features' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Font size" fkey="fontSize" base={9} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}
      {w.type === 'mpg' && (
        <EpSection>
          <Eps>Font Size</Eps>
          <FontStepper label="Number font size" fkey="fontSize" base={28} d={d} fontScale={fontScale} af={af} />
        </EpSection>
      )}

      {/* === Spacing === */}
      {w.type === 'mpg' && (
        <EpSection>
          <Eps>Spacing</Eps>
          <Fd label="Gap between numbers (px)">
            <input type="number" value={(d.gap as number) ?? 120} min={0} max={600} step={4}
              onChange={e => u('gap', +e.target.value)} style={{ ...fiStyle, width: '100%' }} />
          </Fd>
        </EpSection>
      )}

      {/* === Line Spacing === */}
      {(w.type === 'options' || w.type === 'suggested_options') && (
        <EpSection>
          <Eps>Line Spacing</Eps>
          <LineSpacingStepper d={d} u={u} />
        </EpSection>
      )}
      {(w.type === 'dealer' || w.type === 'customtext') && (
        <EpSection>
          <Eps>Line Spacing</Eps>
          <Fd label="Line spacing">
            <input type="number" value={(d.lineHeight as number) || 1.5} min={1.0} max={3.0} step={0.1}
              onChange={e => u('lineHeight', parseFloat(e.target.value))} style={{ ...fiStyle, width: '100%' }} />
          </Fd>
        </EpSection>
      )}

      {/* === Position & Size === */}
      <EpSection>
        <Eps>Position &amp; Size</Eps>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
          {(['x','y','w','h'] as const).map(k => (
            <div key={k}>
              <div style={{ fontSize: 10, color: '#55595c', marginBottom: 3 }}>{k.toUpperCase()}</div>
              <input type="number" value={Math.round(w[k])} onChange={e => fp(k, +e.target.value)}
                step={SNAP} min={k === 'w' ? MIN_W : k === 'h' ? MIN_H : 0}
                style={{ width: '100%', padding: '4px 5px', border: '1px solid #e0e0e0', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }} />
            </div>
          ))}
        </div>
      </EpSection>

      {/* === Layer Order === */}
      {onLayerChange && (
        <EpSection>
          <Eps>Layer Order</Eps>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {([
              ['front', 'Bring to Front'],
              ['back', 'Send to Back'],
              ['forward', 'Bring Forward'],
              ['backward', 'Send Backward'],
            ] as const).map(([action, label]) => (
              <button key={action} onClick={() => onLayerChange(w.id, action)}
                style={{ padding: '5px 4px', borderRadius: 4, border: '1px solid #e0e0e0', background: '#f5f6f7', color: '#333', fontSize: 10, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: '#78828c', marginTop: 5 }}>z-index: {w.z ?? 10}</div>
        </EpSection>
      )}

      {/* === Remove === */}
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

function LineSpacingStepper({ d, u }: {
  d: Record<string, unknown>;
  u: (key: string, val: unknown) => void;
}) {
  const cur = (d.lineSpacing as number) || 1.2;
  const set = (delta: number) => {
    const next = Math.round(Math.max(0.8, Math.min(3.0, cur + delta)) * 10) / 10;
    if (next !== cur) u('lineSpacing', next);
  };
  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #e0e0e0' }}>
      <div style={{ fontSize: 11, color: '#55595c', marginBottom: 4 }}>Line Spacing</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => set(-0.1)} style={stepBtn}>−</button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 11, fontFamily: 'monospace', color: '#1976d2' }}>{cur.toFixed(1)}</div>
        <button onClick={() => set(0.1)} style={stepBtn}>+</button>
      </div>
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
  // 'clear' = transparent bar with all-black text (handled in widgetRenderer).
  const opts: [string, string][] = [['#ffffff', 'White'], ['#000000', 'Black'], ['clear', 'Clear']];
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
      {opts.map(([c, n]) => (
        <div key={c} onClick={() => onChange(c)} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <div style={{
            width: 24, height: 24, borderRadius: 3, flexShrink: 0,
            border: `2px solid ${value === c ? '#2563EB' : '#ccc'}`,
            background: c === 'clear' ? '#fff' : c,
            // Checkerboard so the "Clear" swatch reads as transparent.
            backgroundImage: c === 'clear'
              ? 'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)'
              : undefined,
            backgroundSize: c === 'clear' ? '8px 8px' : undefined,
            backgroundPosition: c === 'clear' ? '0 0,4px 4px' : undefined,
          }} />
          <span style={{ fontSize: 11, color: '#55595c' }}>{n}</span>
        </div>
      ))}
    </div>
  );
}

// Richer swatch palette (matches the Header Bar / Divider pickers) for the
// background + text color controls on the price/suggested bars.
const BAR_SWATCHES: [string, string][] = [
  ['#000000', 'Black'], ['#1a1916', 'Ink'], ['#898989', 'Gray'], ['#1976d2', 'Blue'],
  ['#1a237e', 'Navy'], ['#c62828', 'Red'], ['#15803D', 'Green'], ['#ffffff', 'White'],
];
function ColorSwatches({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {BAR_SWATCHES.map(([c, n]) => (
        <div key={c} title={n} onClick={() => onChange(c)}
          style={{ width: 22, height: 22, borderRadius: 4, background: c, cursor: 'pointer', border: `1.5px solid ${value === c ? '#1976d2' : (c === '#ffffff' ? '#ccc' : 'transparent')}`, boxShadow: value === c ? '0 0 0 2px rgba(37,99,235,.2)' : 'none' }} />
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
