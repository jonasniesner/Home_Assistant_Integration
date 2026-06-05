import { resolvePlotDataEntities } from './entity_autocomplete.js';
import {
  canvasClientToTagPoint,
  estimateItemBounds,
  getResizeHandles,
  hitTestHandle,
  hitTestPayload,
  resizePayloadItem,
  translatePayloadItem,
} from './sketch_hit.js';

export const MIME_OD_PALETTE = 'application/x-opendisplay-designer-palette';

/** @type {Record<string, Record<string, unknown>>} */
export const PALETTE_DEFAULTS = {
  text: { type: 'text', value: 'Hello', x: 8, y: 8, size: 22, color: 'black' },
  multiline: {
    type: 'multiline',
    x: 8,
    y: 12,
    value: 'Alpha|Beta|Gamma',
    delimiter: '|',
    offset_y: 22,
    size: 18,
    color: 'black',
  },
  line: {
    type: 'line',
    x_start: 8,
    y_start: 20,
    x_end: 120,
    y_end: 80,
    color: 'black',
    width: 2,
  },
  rectangle: {
    type: 'rectangle',
    x_start: 8,
    y_start: 8,
    x_end: 104,
    y_end: 56,
    outline: 'black',
    fill: 'white',
    width: 2,
  },
  rectangle_pattern: {
    type: 'rectangle_pattern',
    x_start: 8,
    y_start: 68,
    x_size: 10,
    y_size: 10,
    x_repeat: 4,
    y_repeat: 2,
    x_offset: 4,
    y_offset: 4,
    outline: 'black',
    fill: 'white',
  },
  polygon: {
    type: 'polygon',
    points: [
      [24, 16],
      [100, 32],
      [88, 88],
      [20, 64],
    ],
    outline: 'black',
    fill: 'white',
  },
  circle: {
    type: 'circle',
    x: 80,
    y: 72,
    radius: 28,
    outline: 'black',
    fill: 'white',
    width: 2,
  },
  ellipse: {
    type: 'ellipse',
    x_start: 8,
    y_start: 94,
    x_end: 180,
    y_end: 118,
    outline: 'black',
    fill: 'white',
    width: 2,
  },
  arc: {
    type: 'arc',
    x: 148,
    y: 72,
    radius: 32,
    start_angle: 0,
    end_angle: 220,
    outline: 'black',
    fill: 'white',
    width: 2,
  },
  icon: {
    type: 'icon',
    value: 'mdi:home',
    x: 16,
    y: 24,
    size: 32,
    color: 'black',
    anchor: 'la',
  },
  icon_sequence: {
    type: 'icon_sequence',
    x: 8,
    y: 118,
    size: 20,
    spacing: 6,
    direction: 'right',
    icons: ['mdi:sun-wireless', 'mdi:cloud', 'mdi:weather-night'],
    fill: 'black',
    anchor: 'la',
  },
  qrcode: {
    type: 'qrcode',
    x: 8,
    y: 8,
    data: 'https://home-assistant.io',
    border: 1,
    boxsize: 2,
  },
  dlimg: {
    type: 'dlimg',
    x: 8,
    y: 8,
    url: '/local/your-logo.png',
    xsize: 72,
    ysize: 48,
  },
  plot: {
    type: 'plot',
    x_start: 8,
    y_start: 16,
    x_end: 280,
    y_end: 118,
    low: 0,
    high: 30,
    duration: 86400,
    font: 'ppb.ttf',
    size: 10,
    data: [{ entity: 'sensor.temperature', color: 'black', width: 2 }],
    yaxis: {
      width: 1,
      color: 'black',
      grid: true,
      grid_color: 'black',
      grid_style: 'dotted',
    },
    xaxis: {
      width: 1,
      color: 'black',
      grid: true,
      grid_color: 'black',
      grid_style: 'dotted',
    },
  },
  progress_bar: {
    type: 'progress_bar',
    x_start: 8,
    y_start: 100,
    x_end: 264,
    y_end: 118,
    progress: 62,
    fill: 'black',
    background: 'white',
    outline: 'black',
    direction: 'right',
    width: 2,
    show_percentage: true,
  },
  diagram: {
    type: 'diagram',
    x: 12,
    y: 14,
    height: 100,
    width: 268,
    margin: 22,
    bars: {
      values: 'A,8;B,14;C,10',
      margin: 8,
      legend_size: 9,
      font: 'ppb.ttf',
      legend_color: 'black',
      color: 'black',
    },
  },
};

export const ELEMENT_PALETTE_ORDER = /** @type {const} */ ([
  ['text', 'text'],
  ['multiline', 'multi'],
  ['line', 'line'],
  ['rectangle', 'rect'],
  ['rectangle_pattern', 'pattern'],
  ['polygon', 'poly'],
  ['circle', 'circle'],
  ['ellipse', 'ellipse'],
  ['arc', 'arc'],
  ['icon', 'icon'],
  ['icon_sequence', 'icons'],
  ['qrcode', 'qr'],
  ['dlimg', 'image'],
  ['plot', 'plot'],
  ['progress_bar', 'bar'],
  ['diagram', 'chart'],
]);

export const KNOWN_ELEMENT_TYPES = new Set(Object.keys(PALETTE_DEFAULTS));

/**
 * @param {HTMLElement} paletteRoot
 */
export function setupPaletteChips(paletteRoot) {
  for (const row of ELEMENT_PALETTE_ORDER) {
    const kind = row[0];
    const short = row[1];
    if (!(kind in PALETTE_DEFAULTS)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'od-palette-chip';
    btn.draggable = true;
    btn.dataset.odKind = kind;
    btn.textContent = short;
    btn.title = kind;
    paletteRoot.appendChild(btn);
  }
  paletteRoot.addEventListener('dragstart', (ev) => {
    const chip = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (ev.target).closest('.od-palette-chip[data-od-kind]')
    );
    if (!chip) return;
    const kind = chip.dataset.odKind || '';
    try {
      ev.dataTransfer?.setData(MIME_OD_PALETTE, kind);
      ev.dataTransfer?.setData('text/plain', kind);
    } catch {
      /* noop */
    }
    const dt = ev.dataTransfer;
    if (dt) dt.effectAllowed = 'copy';
  });
}

/**
 * @param {{
 *  sketchCanvas: HTMLCanvasElement;
 *  previewFrame: HTMLElement;
 *  previewImgEl: HTMLImageElement;
 *  getHass: () => any;
 *  getTagPx: () => { tagW: number; tagH: number };
 *  silentParsePayload: () => unknown[] | null;
 *  applyEditedPayload: (parsed: unknown[]) => void;
 *  validatePayload: () => boolean;
 *  updateSelectionUi: () => void;
 *  showToast: (msg: string, isErr: boolean) => void;
 *  leaveHaForEdit: () => void;
 *  scheduleRedrawSketch: () => void;
 *  state: {
 *    selectedItemIdx: number;
 *    sketchEdit: {
 *      pointerId: number;
 *      mode: 'move' | 'resize';
 *      idx: number;
 *      lastTx: number;
 *      lastTy: number;
 *      handle?: { id: string; kind: string; x: number; y: number; vertexIndex?: number } | null;
 *    } | null;
 *  };
 * }} deps
 */
export function attachSketchEditor(deps) {
  const {
    sketchCanvas,
    previewFrame,
    previewImgEl,
    getHass,
    getTagPx,
    silentParsePayload,
    applyEditedPayload,
    validatePayload,
    updateSelectionUi,
    showToast,
    leaveHaForEdit,
    scheduleRedrawSketch,
    state,
  } = deps;

  function clearSelection() {
    state.selectedItemIdx = -1;
    state.sketchEdit = null;
    sketchCanvas.style.cursor = '';
    updateSelectionUi();
  }

  sketchCanvas.addEventListener('pointerdown', (ev) => {
    const parsed = silentParsePayload();
    if (!parsed) return;
    leaveHaForEdit();
    const pt = canvasClientToTagPoint(sketchCanvas, ev.clientX, ev.clientY);
    if (!pt) return;
    const { tagW, tagH } = getTagPx();
    const hass = getHass();

    if (state.selectedItemIdx >= 0 && state.selectedItemIdx < parsed.length) {
      const currentHandles = getResizeHandles(parsed[state.selectedItemIdx], hass, tagW, tagH);
      const h = hitTestHandle(pt.tx, pt.ty, currentHandles);
      if (h) {
        sketchCanvas.setPointerCapture(ev.pointerId);
        state.sketchEdit = {
          pointerId: ev.pointerId,
          mode: h.kind === 'meta' ? 'move' : 'resize',
          idx: state.selectedItemIdx,
          lastTx: pt.tx,
          lastTy: pt.ty,
          handle: h,
        };
        sketchCanvas.style.cursor = 'grabbing';
        ev.preventDefault();
        scheduleRedrawSketch();
        return;
      }
    }

    const idx = hitTestPayload(pt.tx, pt.ty, parsed, hass, tagW, tagH);
    if (idx < 0) {
      clearSelection();
      scheduleRedrawSketch();
      return;
    }
    state.selectedItemIdx = idx;
    updateSelectionUi();
    sketchCanvas.setPointerCapture(ev.pointerId);
    state.sketchEdit = {
      pointerId: ev.pointerId,
      mode: 'move',
      idx,
      lastTx: pt.tx,
      lastTy: pt.ty,
      handle: null,
    };
    sketchCanvas.style.cursor = 'grabbing';
    ev.preventDefault();
    scheduleRedrawSketch();
  });

  sketchCanvas.addEventListener('pointermove', (ev) => {
    if (!state.sketchEdit) {
      const parsed = silentParsePayload();
      const pt = canvasClientToTagPoint(sketchCanvas, ev.clientX, ev.clientY);
      if (!parsed || !pt || state.selectedItemIdx < 0 || state.selectedItemIdx >= parsed.length) {
        sketchCanvas.style.cursor = '';
        return;
      }
      const { tagW, tagH } = getTagPx();
      const hass = getHass();
      const hs = getResizeHandles(parsed[state.selectedItemIdx], hass, tagW, tagH);
      const hh = hitTestHandle(pt.tx, pt.ty, hs);
      sketchCanvas.style.cursor =
        hh?.cursor ||
        (hitTestPayload(pt.tx, pt.ty, parsed, hass, tagW, tagH) >= 0 ? 'grab' : '');
      return;
    }
    const parsed = silentParsePayload();
    if (!parsed || state.sketchEdit.idx >= parsed.length) {
      state.sketchEdit = null;
      sketchCanvas.style.cursor = '';
      return;
    }
    const pt = canvasClientToTagPoint(sketchCanvas, ev.clientX, ev.clientY);
    if (!pt) return;
    const dx = pt.tx - state.sketchEdit.lastTx;
    const dy = pt.ty - state.sketchEdit.lastTy;
    state.sketchEdit.lastTx = pt.tx;
    state.sketchEdit.lastTy = pt.ty;
    if (dx === 0 && dy === 0) return;
    const el = parsed[state.sketchEdit.idx];
    if (!el || typeof el !== 'object' || Array.isArray(el)) return;
    const { tagW, tagH } = getTagPx();
    const hass = getHass();
    if (state.sketchEdit.mode === 'resize' && state.sketchEdit.handle) {
      resizePayloadItem(el, state.sketchEdit.handle, dx, dy, { hass, tagW, tagH });
    } else {
      translatePayloadItem(el, dx, dy, { tagW, tagH });
    }
    applyEditedPayload(parsed);
    ev.preventDefault();
  });

  function stopSketchEdit() {
    state.sketchEdit = null;
    sketchCanvas.style.cursor = '';
    scheduleRedrawSketch();
  }

  sketchCanvas.addEventListener('pointerup', stopSketchEdit);
  sketchCanvas.addEventListener('lostpointercapture', stopSketchEdit);
  previewImgEl.addEventListener('pointerdown', () => leaveHaForEdit());

  previewFrame.addEventListener('dragover', (e) => {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch {
      /* noop */
    }
  });

  previewFrame.addEventListener('drop', (e) => {
    e.preventDefault();
    leaveHaForEdit();
    const parsed = silentParsePayload();
    if (!parsed) {
      showToast('Fix YAML before adding elements.', true);
      return;
    }
    const pt = canvasClientToTagPoint(sketchCanvas, e.clientX, e.clientY);
    if (!pt) return;
    const { tagW, tagH } = getTagPx();
    const hass = getHass();
    const kindRaw =
      e.dataTransfer?.getData(MIME_OD_PALETTE) ||
      e.dataTransfer?.getData('text/plain') ||
      '';
    const kind = String(kindRaw).trim();
    const base = PALETTE_DEFAULTS[kind];
    if (!base) return;
    const item = /** @type {Record<string, unknown>} */ (
      JSON.parse(JSON.stringify(base))
    );
    if (String(item.type) === 'plot') {
      const resolved = resolvePlotDataEntities(hass, item.data);
      if (resolved) item.data = resolved;
    }
    const b = estimateItemBounds(item, hass, tagW, tagH);
    if (b) {
      const cx = (b.x + b.x2) / 2;
      const cy = (b.y + b.y2) / 2;
      translatePayloadItem(item, pt.tx - cx, pt.ty - cy, { tagW, tagH });
    }
    parsed.push(item);
    state.selectedItemIdx = parsed.length - 1;
    applyEditedPayload(parsed);
    validatePayload();
    updateSelectionUi();
  });

  return { clearSelection };
}
