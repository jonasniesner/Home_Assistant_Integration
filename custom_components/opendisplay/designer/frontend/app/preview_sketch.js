/**
 * Browser sketch preview aligned with odl-renderer layout rules where possible.
 * Fonts/icons still differ; dry-run sends these resolved values to drawcustom.
 */

/** @param {unknown} value @param {number} totalDim */
export function parseDimension(value, totalDim) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const s = String(value ?? '').trim();
  if (!s) return 0;
  if (s.endsWith('%')) {
    const p = parseFloat(s.slice(0, -1));
    return Number.isFinite(p) ? Math.round((p / 100) * totalDim) : 0;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const COLORED_TEXT_RE = new RegExp(
  String.raw`\[(black|b|white|w|red|r|yellow|y|blue|bl|green|gr|g|accent|a|half_black|half_white|half_red|half_yellow|half_accent|gray|grey|hb|hw|hr|hy|ha|#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6})\]([\s\S]*?)\[/\1\]`,
  'gi'
);

/** @param {string} text @returns {Array<{ text: string; color: string }>} */
function parseColoredText(text) {
  const segments = [];
  let pos = 0;
  COLORED_TEXT_RE.lastIndex = 0;
  let m = COLORED_TEXT_RE.exec(text);
  while (m) {
    if (m.index > pos) {
      segments.push({ text: text.slice(pos, m.index), color: 'black' });
    }
    segments.push({ text: m[2], color: m[1] });
    pos = m.index + m[0].length;
    m = COLORED_TEXT_RE.exec(text);
  }
  if (pos < text.length) {
    segments.push({ text: text.slice(pos), color: 'black' });
  }
  return segments.length ? segments : [{ text, color: 'black' }];
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {Array<{ text: string; color: string }>} segments
 * @param {number} fontSize
 * @param {string} accentColor
 */
function drawColoredSegments(ctx, x, y, segments, fontSize, accentColor) {
  let cx = x;
  for (const seg of segments) {
    ctx.fillStyle = cssColor(seg.color, accentColor);
    ctx.fillText(seg.text, cx, y);
    cx += ctx.measureText(seg.text).width;
  }
}

/** @param {string} c */
function cssColor(c, accentFallback) {
  if (!c || typeof c !== 'string') return '#000';
  const s = c.trim().toLowerCase();
  const map = {
    black: '#000',
    white: '#fff',
    red: '#c00',
    yellow: '#c9a000',
    accent: accentFallback,
    a: accentFallback,
    half_black: '#888',
    gray: '#888',
    grey: '#888',
    half_red: '#e88',
    half_yellow: '#dd8',
    half_accent: accentFallback,
    ha: accentFallback,
    b: '#000',
    w: '#fff',
    r: '#c00',
    y: '#c9a00',
    hb: '#888',
    hw: '#ccc',
    hr: '#e88',
    hy: '#dd8',
  };
  if (map[s]) return map[s];
  if (s.startsWith('#') && (s.length === 4 || s.length === 7)) return s;
  return s;
}

/**
 * Pillow draw.text(..., anchor='lt'): (x, y) is the top-left of the ink bbox.
 * Canvas fillText alphabetic baseline: y_baseline ≈ pilTopY + ascent.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} pilTopY
 * @param {number} fontSizePx
 * @param {string} ascentSample single char used for ascent measure
 */
function baselineYFromPilTop(ctx, pilTopY, fontSizePx, ascentSample) {
  ctx.textBaseline = 'alphabetic';
  const ch = ascentSample ? String(ascentSample).replace(/\s/g, '') || 'x' : 'x';
  const m = ctx.measureText(ch.slice(0, 1));
  const asc =
    Number.isFinite(m.actualBoundingBoxAscent) &&
    m.actualBoundingBoxAscent > 0
      ? m.actualBoundingBoxAscent
      : Math.max(fontSizePx * 0.72, 8);
  return pilTopY + asc;
}

/**
 * @param {any} hass
 * @param {string} entityId
 */
function entityState(hass, entityId) {
  const st = hass?.states?.[entityId];
  if (!st || st.state == null) return '';
  const s = String(st.state);
  if (s === 'unknown' || s === 'unavailable') return '';
  return s;
}

/**
 * @param {any} hass
 * @param {string} entityId
 * @param {string} attr
 */
function entityAttr(hass, entityId, attr) {
  const attrs = hass?.states?.[entityId]?.attributes;
  if (!attrs || !(attr in attrs)) return '';
  const v = attrs[attr];
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** @param {string} value @param {string} [filterExpr] */
function applyTemplateFilter(value, filterExpr) {
  const f = String(filterExpr || '');
  if (/\|\s*int\b/i.test(f)) {
    const m = f.match(/int\s*\(\s*(-?\d+)\s*\)/i);
    const fallback = m ? parseInt(m[1], 10) : 0;
    const n = parseInt(String(value), 10);
    return Number.isFinite(n) ? String(n) : String(fallback);
  }
  if (/\|\s*float\s*\(/i.test(f)) {
    const m = f.match(/float\s*\(\s*(-?[\d.]+)\s*\)/i);
    const fallback = m ? parseFloat(m[1]) : 0;
    const n = parseFloat(String(value));
    return Number.isFinite(n) ? String(n) : String(fallback);
  }
  if (/\|\s*string\b/i.test(f)) {
    return String(value ?? '');
  }
  return value;
}

/**
 * @param {string} anchor
 * @param {number} blockW
 * @param {number} blockH
 * @param {number} fontSize
 */
function textAnchorOffset(anchor, blockW, blockH) {
  const a = String(anchor || 'lt').toLowerCase();
  const h = a[0] || 'l';
  const v = a[1] || 't';
  let dx = 0;
  let dy = 0;
  if (h === 'm') dx = -blockW / 2;
  else if (h === 'r') dx = -blockW;
  if (v === 'm') dy = -blockH / 2;
  else if (v === 'b' || v === 'd') dy = -blockH;
  return { dx, dy };
}

/** Fields in drawcustom elements that may contain HA Jinja templates. */
const TEMPLATE_FIELD_NAMES = new Set([
  'value',
  'color',
  'fill',
  'outline',
  'stroke_fill',
  'legend_color',
  'background',
  'url',
  'progress',
  'data',
]);

/**
 * Clone payload and replace `{{ ... }}` with sketch-preview values.
 * HA dry-run only — real sends/automation export keep raw templates.
 * @param {any} hass
 * @param {unknown[]} payload
 */
export function resolvePayloadForDryRun(hass, payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const item = { .../** @type {Record<string, unknown>} */ (raw) };
    for (const [key, val] of Object.entries(item)) {
      if (typeof val === 'string' && TEMPLATE_FIELD_NAMES.has(key) && /\{\{/.test(val)) {
        item[key] = resolveTemplates(hass, val);
      }
    }
    return item;
  });
}

/**
 * @param {any} hass
 * @param {string} template
 */
export function resolveTemplates(hass, template) {
  if (typeof template !== 'string') return String(template ?? '');
  let out = template;

  out = out.replace(
    /\{%\s*if\s+is_state\s*\(\s*(['"])([a-zA-Z0-9_.]+)\1\s*,\s*(['"])([^'"]*)\3\s*\)\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/gi,
    (_, _q1, eid, _q2, want, whenTrue, whenFalse) =>
      entityState(hass, eid) === String(want) ? whenTrue.trim() : whenFalse.trim()
  );

  out = out.replace(
    /\{%\s*if\s+is_state\s*\(\s*(['"])([a-zA-Z0-9_.]+)\1\s*,\s*(['"])([^'"]*)\3\s*\)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/gi,
    (_, _q1, eid, _q2, want, body) =>
      entityState(hass, eid) === String(want) ? body.trim() : ''
  );

  out = out.replace(
    /\{\{\s*state_attr\s*\(\s*(['"])([a-zA-Z0-9_.]+)\1\s*,\s*(['"])([a-z0-9_ -]+)\3\s*\)\s*(\|[^}]*)?\s*\}\}/gi,
    (_, _q1, eid, _q2, attr, filter) =>
      applyTemplateFilter(entityAttr(hass, eid, attr), filter)
  );

  out = out.replace(
    /\{\{\s*states\s*\(\s*(['"])([a-zA-Z0-9_.]+)\1\s*\)\s*(\|[^}]*)?\s*\}\}/gi,
    (_, _q, eid, filter) => applyTemplateFilter(entityState(hass, eid), filter)
  );

  out = out.replace(
    /\{\{\s*is_state\s*\(\s*(['"])([a-zA-Z0-9_.]+)\1\s*,\s*(['"])([^'"]*)\3\s*\)\s*(\|[^}]*)?\s*\}\}/gi,
    (_, _q1, eid, _q2, want, filter) => {
      const actual = entityState(hass, eid);
      const match = actual === String(want);
      return applyTemplateFilter(match ? 'true' : 'false', filter);
    }
  );

  out = out.replace(
    /\{\{\s*(['"])([^'"]+)\1\s+if\s+is_state\s*\(\s*(['"])([a-zA-Z0-9_.]+)\3\s*,\s*(['"])([^'"]*)\5\s*\)\s+else\s+(['"])([^'"]+)\7\s*\}\}/gi,
    (_, _q1, whenTrue, _q2, eid, _q3, want, _q4, whenFalse) =>
      entityState(hass, eid) === String(want) ? whenTrue : whenFalse
  );

  return out;
}

/**
 * @param {any} hass
 * @param {unknown} template
 * @param {number} [fallback]
 */
export function resolveTemplateNumber(hass, template, fallback = 0) {
  if (typeof template === 'number' && Number.isFinite(template)) return template;
  const raw = String(template ?? '').trim();
  if (!raw) return fallback;
  if (!/\{\{/.test(raw)) {
    const direct = Number(raw);
    return Number.isFinite(direct) ? direct : fallback;
  }
  const resolved = resolveTemplates(hass, raw);
  const n = parseFloat(resolved);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Fit logical bitmap (rw×rh px) inside the preview frame; shared by sketch canvas + HA image overlay.
 * @param {HTMLElement | null} container
 * @param {number} rw
 * @param {number} rh
 */
export function computePreviewCssSize(container, rw, rh) {
  const w = Math.max(16, Math.round(rw)) || 296;
  const h = Math.max(16, Math.round(rh)) || 128;
  const maxCssW =
    container && container.clientWidth > 0 ? container.clientWidth - 4 : 480;
  const maxCssH =
    container && container.clientHeight > 0 ? container.clientHeight - 4 : 560;
  const scale = Math.min(maxCssW / w, maxCssH / h) || 1;
  return { cssW: Math.round(w * scale), cssH: Math.round(h * scale) };
}

/**
 * Split preview: pick side-by-side vs stacked from frame size and tag aspect ratio.
 * @param {HTMLElement | null} container
 * @param {number} rw
 * @param {number} rh
 * @returns {{ direction: 'columns' | 'rows'; cssW: number; cssH: number; scale: number }}
 */
export function computeSplitPreviewLayout(container, rw, rh) {
  const w = Math.max(16, Math.round(rw)) || 296;
  const h = Math.max(16, Math.round(rh)) || 128;
  const pad = 10;
  const labelH = 20;
  const gap = 8;
  const frameW =
    container && container.clientWidth > 0 ? container.clientWidth - pad : 520;
  const frameH =
    container && container.clientHeight > 0 ? container.clientHeight - pad : 360;

  const paneWCols = Math.max(40, (frameW - gap) / 2);
  const paneHCols = Math.max(40, frameH - labelH);
  const scaleCols = Math.min(paneWCols / w, paneHCols / h);

  const paneWRows = Math.max(40, frameW);
  const paneHRows = Math.max(40, (frameH - labelH * 2 - gap) / 2);
  const scaleRows = Math.min(paneWRows / w, paneHRows / h);

  const useColumns = scaleCols >= scaleRows * 0.92;
  const scale = Math.max(0.08, useColumns ? scaleCols : scaleRows);
  return {
    direction: useColumns ? 'columns' : 'rows',
    cssW: Math.max(8, Math.round(w * scale)),
    cssH: Math.max(8, Math.round(h * scale)),
    scale,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {any} hass
 * @param {unknown[]} payload
 * @param {number} tagW
 * @param {number} tagH
 * @param {string} background
 * @param {number} rotateDeg
 * @param {string} accentColor
 * @param {boolean} [transparentBackdrop] when true (e.g. overlay on HA bitmap), skip solid fill
 * @param {{ cssW: number; cssH: number } | null} [fixedCss] when set (e.g. from panel), keeps sketch/img overlay pixel-aligned
 * @param {{ x:number; y:number; x2:number; y2:number } | null} [selectedBounds]
 * @param {Array<{ id:string; x:number; y:number }> | null} [selectedHandles]
 * @param {string | null} [activeHandleId]
 */
export function paintPayloadSketch(
  canvas,
  hass,
  payload,
  tagW,
  tagH,
  background,
  rotateDeg,
  accentColor,
  transparentBackdrop = false,
  fixedCss = null,
  selectedBounds = null,
  selectedHandles = null,
  activeHandleId = null
) {
  const w = Math.max(16, Math.round(tagW)) || 296;
  const h = Math.max(16, Math.round(tagH)) || 128;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pilW =
    rotateDeg === 90 || rotateDeg === 270 ? h : w;
  const pilH =
    rotateDeg === 90 || rotateDeg === 270 ? w : h;
  const rw = w;
  const rh = h;

  const resolved =
    fixedCss && fixedCss.cssW > 0 && fixedCss.cssH > 0
      ? fixedCss
      : computePreviewCssSize(canvas.parentElement, rw, rh);
  const { cssW, cssH } = resolved;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(rw * dpr);
  canvas.height = Math.round(rh * dpr);

  const cAny = /** @type {HTMLCanvasElement & { odScratchCanvas?: HTMLCanvasElement }} */ (
    canvas
  );
  let scratch = cAny.odScratchCanvas;
  if (!scratch) {
    scratch = document.createElement('canvas');
    cAny.odScratchCanvas = scratch;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    delete canvas.__odPxToTag;
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (transparentBackdrop) {
    ctx.clearRect(0, 0, rw, rh);
  } else {
    ctx.fillStyle = cssColor(background, accentColor);
    ctx.fillRect(0, 0, rw, rh);
  }

  scratch.width = Math.round(pilW * dpr);
  scratch.height = Math.round(pilH * dpr);
  const pctx = scratch.getContext('2d');
  if (!pctx) {
    delete canvas.__odPxToTag;
    return;
  }
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, pilW, pilH);

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    const type = String(item.type || '').toLowerCase();

    pctx.save();

    switch (type) {
      case 'text': {
        const val = resolveTemplates(hass, /** @type {string} */ (item.value ?? ''));
        const x = parseDimension(item.x, pilW);
        const y =
          item.y == null
            ? 0
            : parseDimension(item.y, pilH);
        const size = Math.max(8, parseDimension(item.size ?? 20, pilH));
        const spRaw = Number(item.spacing);
        const spacing = Number.isFinite(spRaw) && spRaw >= 0 ? spRaw : 5;
        const lineHeight = Math.round(size * 1.2);
        const lineTopStep = lineHeight + spacing;
        const parseColors = Boolean(item.parse_colors);
        const defaultColor = cssColor(
          resolveTemplates(hass, String(item.color || 'black')),
          accentColor
        );
        pctx.font = `${size}px ui-monospace, monospace`;
        const lines = val.split(/\r?\n/);
        const drawLines = lines.map((line) => line.slice(0, 200));
        let blockW = 0;
        for (const line of drawLines) {
          blockW = Math.max(blockW, pctx.measureText(line || ' ').width);
        }
        const blockH =
          drawLines.length > 0
            ? lineHeight + (drawLines.length - 1) * lineTopStep
            : lineHeight;
        const anchor = String(
          item.anchor || (drawLines.length > 1 ? 'la' : 'lt')
        );
        const { dx, dy } = textAnchorOffset(anchor, blockW, blockH);
        let pilTopY = y + dy;
        const drawX = x + dx;
        for (const line of drawLines) {
          const by = baselineYFromPilTop(
            pctx,
            pilTopY,
            size,
            line || 'x'
          );
          if (parseColors) {
            drawColoredSegments(
              pctx,
              drawX,
              by,
              parseColoredText(line),
              size,
              accentColor
            );
          } else {
            pctx.fillStyle = defaultColor;
            pctx.fillText(line, drawX, by);
          }
          pilTopY += lineTopStep;
        }
        break;
      }
      case 'line': {
        pctx.strokeStyle = cssColor(String(item.color || 'black'), accentColor);
        pctx.lineWidth = Number(item.width) || 2;
        pctx.beginPath();
        pctx.moveTo(Number(item.x_start) || 0, Number(item.y_start) || 0);
        pctx.lineTo(Number(item.x_end) || 0, Number(item.y_end) || 0);
        pctx.stroke();
        break;
      }
      case 'rectangle': {
        let x1;
        let y1;
        let x2;
        let y2;
        if (
          item.x_start != null &&
          item.x_end != null &&
          item.y_start != null &&
          item.y_end != null
        ) {
          x1 = Number(item.x_start) || 0;
          y1 = Number(item.y_start) || 0;
          x2 = Number(item.x_end) || x1 + 48;
          y2 = Number(item.y_end) || y1 + 28;
        } else {
          const x = Number(item.x) || 0;
          const y = Number(item.y) || 0;
          x1 = x;
          y1 = y;
          x2 = x + (Number(item.width) || 48);
          y2 = y + (Number(item.height) || 28);
        }
        const lw = Number(item.border_width ?? item.width_outline ?? item.width) || 2;
        const fill = item.fill != null ? cssColor(String(item.fill), accentColor) : null;
        const outline = cssColor(String(item.outline || 'black'), accentColor);
        pctx.lineWidth = lw;
        if (fill) {
          pctx.fillStyle = fill;
          pctx.fillRect(
            Math.min(x1, x2),
            Math.min(y1, y2),
            Math.abs(x2 - x1),
            Math.abs(y2 - y1)
          );
        }
        pctx.strokeStyle = outline;
        pctx.strokeRect(
          Math.min(x1, x2),
          Math.min(y1, y2),
          Math.abs(x2 - x1),
          Math.abs(y2 - y1)
        );
        break;
      }
      case 'rectangle_pattern': {
        const sx0 = Number(item.x_start) || 0;
        const sy0 = Number(item.y_start) || 0;
        const xsz = Number(item.x_size) || 10;
        const ysz = Number(item.y_size) || 10;
        const xr = Math.max(1, Math.floor(Number(item.x_repeat) || 1));
        const yr = Math.max(1, Math.floor(Number(item.y_repeat) || 1));
        const xo = Number(item.x_offset) || 0;
        const yo = Number(item.y_offset) || 0;
        const fillRp = item.fill != null ? cssColor(String(item.fill), accentColor) : null;
        const outRp = cssColor(String(item.outline || 'black'), accentColor);
        for (let ix = 0; ix < xr; ix += 1) {
          for (let iy = 0; iy < yr; iy += 1) {
            const px = sx0 + ix * (xsz + xo);
            const py = sy0 + iy * (ysz + yo);
            if (fillRp) {
              pctx.fillStyle = fillRp;
              pctx.fillRect(px, py, xsz, ysz);
            }
            pctx.strokeStyle = outRp;
            pctx.lineWidth = Number(item.width) || 1;
            pctx.strokeRect(px, py, xsz, ysz);
          }
        }
        break;
      }
      case 'polygon': {
        pctx.strokeStyle = cssColor(String(item.outline || 'black'), accentColor);
        pctx.lineWidth = 1;
        if (Array.isArray(item.points) && item.points.length > 2) {
          pctx.beginPath();
          const pts = /** @type {unknown[]} */ (item.points);
          const p0 = /** @type {number[]} */ (pts[0]);
          pctx.moveTo(p0?.[0] ?? 0, p0?.[1] ?? 0);
          for (let i = 1; i < pts.length; i += 1) {
            const p = /** @type {number[]} */ (pts[i]);
            pctx.lineTo(p?.[0] ?? 0, p?.[1] ?? 0);
          }
          pctx.closePath();
          if (item.fill) {
            pctx.fillStyle = cssColor(String(item.fill), accentColor);
            pctx.fill();
          }
          pctx.stroke();
        }
        break;
      }
      case 'circle': {
        const cx = Number(item.x) || 0;
        const cy = Number(item.y) || 0;
        const r = Number(item.radius) || 22;
        pctx.beginPath();
        pctx.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2);
        if (item.fill) {
          pctx.fillStyle = cssColor(String(item.fill), accentColor);
          pctx.fill();
        }
        pctx.strokeStyle = cssColor(String(item.outline || 'black'), accentColor);
        pctx.lineWidth = Number(item.width) || 2;
        pctx.stroke();
        break;
      }
      case 'ellipse': {
        const xe1 = Number(item.x_start) || 0;
        const ye1 = Number(item.y_start) || 0;
        const xe2 = Number(item.x_end) || xe1 + 40;
        const ye2 = Number(item.y_end) || ye1 + 28;
        const mx = (xe1 + xe2) / 2;
        const my = (ye1 + ye2) / 2;
        const rx = Math.abs(xe2 - xe1) / 2;
        const ry = Math.abs(ye2 - ye1) / 2;
        pctx.beginPath();
        pctx.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2);
        if (item.fill) {
          pctx.fillStyle = cssColor(String(item.fill), accentColor);
          pctx.fill();
        }
        pctx.strokeStyle = cssColor(String(item.outline || 'black'), accentColor);
        pctx.lineWidth = Number(item.width) || 2;
        pctx.stroke();
        break;
      }
      case 'progress_bar': {
        const xs = parseDimension(item.x_start, pilW);
        const ys = parseDimension(item.y_start, pilH);
        const xe = parseDimension(item.x_end, pilW);
        const ye = parseDimension(item.y_end, pilH);
        const pct = Math.max(
          0,
          Math.min(100, resolveTemplateNumber(hass, item.progress, 0))
        );
        pctx.strokeStyle = '#333';
        pctx.strokeRect(xs, ys, xe - xs, ye - ys);
        pctx.fillStyle = cssColor(String(item.fill || 'black'), accentColor);
        const pw = ((xe - xs) * pct) / 100;
        pctx.fillRect(xs, ys, pw, ye - ys);
        break;
      }
      case 'arc': {
        const cx = Number(item.x) || Number(item.cx) || 0;
        const cy = Number(item.y) || Number(item.cy) || 0;
        const r = Number(item.radius) || 30;
        const start = ((Number(item.start_angle) || 0) * Math.PI) / 180;
        const end = ((Number(item.end_angle) || 360) * Math.PI) / 180;
        pctx.beginPath();
        pctx.arc(cx, cy, r, start, end);
        if (item.fill) {
          pctx.fillStyle = cssColor(String(item.fill), accentColor);
          pctx.fill();
        }
        pctx.strokeStyle = cssColor(String(item.outline || 'black'), accentColor);
        pctx.stroke();
        break;
      }
      case 'icon': {
        const x = parseDimension(item.x, pilW);
        const y = parseDimension(item.y, pilH);
        const sz = parseDimension(item.size ?? 24, pilH);
        const color = cssColor(
          resolveTemplates(hass, String(item.color || 'black')),
          accentColor
        );
        const name = resolveTemplates(hass, String(item.value || 'mdi:help'));
        pctx.fillStyle = color;
        pctx.strokeStyle = color;
        pctx.strokeRect(x, y, sz * 1.1, sz * 1.1);
        pctx.font = `${Math.max(8, sz * 0.35)}px sans-serif`;
        pctx.textBaseline = 'top';
        pctx.fillText(name.replace(/^mdi:/, '').slice(0, 8), x, y);
        break;
      }
      case 'icon_sequence': {
        const x0 = Number(item.x) || 0;
        const y0 = Number(item.y) || 0;
        const sz = Number(item.size) || 20;
        const sp = Number(item.spacing) || sz / 4;
        const icons = /** @type {unknown[]} */ (Array.isArray(item.icons) ? item.icons : []);
        const dir = String(item.direction || 'right');
        pctx.strokeStyle = cssColor(String(item.fill || 'black'), accentColor);
        pctx.font = `${Math.max(8, sz * 0.3)}px sans-serif`;
        pctx.textBaseline = 'top';
        for (let i = 0; i < Math.min(icons.length, 6); i += 1) {
          const nm = String(icons[i] || '').replace(/^mdi:/, '').slice(0, 4);
          if (dir === 'down' || dir === 'up') {
            pctx.strokeRect(x0, y0 + i * (sz + sp), sz, sz);
            pctx.fillText(nm, x0 + 2, y0 + i * (sz + sp) + 3);
          } else {
            pctx.strokeRect(x0 + i * (sz + sp), y0, sz, sz);
            pctx.fillText(nm, x0 + i * (sz + sp) + 2, y0 + 3);
          }
        }
        break;
      }
      case 'multiline': {
        const x = parseDimension(item.x, pilW);
        const y = parseDimension(item.y, pilH);
        const oy = parseDimension(item.offset_y ?? 20, pilH);
        const fz = Math.max(8, parseDimension(item.size ?? 18, pilH));
        const color = cssColor(
          resolveTemplates(hass, String(item.color || 'black')),
          accentColor
        );
        const del = String(item.delimiter || '|');
        const val = resolveTemplates(hass, String(item.value ?? ''));
        const lines = val.split(del);
        const parseColors = Boolean(item.parse_colors);
        pctx.font = `${fz}px ui-monospace, monospace`;
        let pilTopY = y;
        for (const line of lines) {
          const slice = line.slice(0, 120);
          const by = baselineYFromPilTop(pctx, pilTopY, fz, slice || 'x');
          if (parseColors) {
            drawColoredSegments(
              pctx,
              x,
              by,
              parseColoredText(slice),
              fz,
              accentColor
            );
          } else {
            pctx.fillStyle = color;
            pctx.fillText(slice, x, by);
          }
          pilTopY += oy;
        }
        break;
      }
      case 'qrcode':
      case 'qr_code': {
        const x = Number(item.x) || 0;
        const y = Number(item.y) || 0;
        const box = Number(item.box_size) || Math.min(80, (Number(item.boxsize) || 2) * 28);
        pctx.strokeStyle = '#000';
        pctx.strokeRect(x, y, box, box);
        pctx.fillStyle = '#000';
        pctx.font = '10px monospace';
        pctx.fillText('QR', x + 3, y + 12);
        break;
      }
      case 'dlimg': {
        const x = Number(item.x) || 0;
        const y = Number(item.y) || 0;
        const iw = Number(item.xsize) || 48;
        const ih = Number(item.ysize) || 36;
        pctx.strokeStyle = '#444';
        pctx.setLineDash([4, 3]);
        pctx.strokeRect(x, y, iw, ih);
        pctx.setLineDash([]);
        pctx.fillStyle = '#666';
        pctx.font = '10px sans-serif';
        pctx.fillText('img', x + 4, y + 14);
        break;
      }
      case 'diagram': {
        const dx = Number(item.x) || 0;
        const dy = Number(item.y) || 0;
        const dh = Number(item.height) || 80;
        const dw = Number(item.width) || Math.min(pilW - dx - 8, 200);
        const m = Number(item.margin) || 18;
        const yBase = dy + 6;
        pctx.strokeStyle = '#333';
        pctx.lineWidth = 1;
        pctx.beginPath();
        pctx.moveTo(dx + m, yBase);
        pctx.lineTo(dx + m, yBase + dh - m);
        pctx.lineTo(dx + dw, yBase + dh - m);
        pctx.stroke();
        pctx.fillStyle = '#666';
        pctx.font = '10px sans-serif';
        pctx.fillText('diagram', dx + m + 4, yBase + 12);
        break;
      }
      case 'plot': {
        const xs = Number(item.x_start);
        const ys = Number(item.y_start);
        const xe = Number(item.x_end);
        const ye = Number(item.y_end);
        pctx.strokeStyle = '#666';
        pctx.strokeRect(xs, ys, xe - xs, ye - ys);
        pctx.fillStyle = '#666';
        pctx.font = '10px sans-serif';
        pctx.fillText('plot', xs + 2, ys + 12);
        break;
      }
      case 'debug_grid': {
        pctx.strokeStyle = 'rgba(0,0,0,0.15)';
        const sp = Number(item.spacing) || 20;
        for (let gx = 0; gx < pilW; gx += sp) {
          pctx.beginPath();
          pctx.moveTo(gx, 0);
          pctx.lineTo(gx, pilH);
          pctx.stroke();
        }
        for (let gy = 0; gy < pilH; gy += sp) {
          pctx.beginPath();
          pctx.moveTo(0, gy);
          pctx.lineTo(pilW, gy);
          pctx.stroke();
        }
        break;
      }
      default: {
        const x = Number(item.x) || Number(item.x_start) || 8;
        const y = Number(item.y) || Number(item.y_start) || 8;
        pctx.fillStyle = 'rgba(128,128,128,0.5)';
        pctx.font = '11px sans-serif';
        pctx.fillText(`[${type || '?'}]`, x, y);
      }
    }
    pctx.restore();
  }

  if (selectedBounds) {
    const bx = Math.min(selectedBounds.x, selectedBounds.x2);
    const by = Math.min(selectedBounds.y, selectedBounds.y2);
    const bw = Math.max(1, Math.abs(selectedBounds.x2 - selectedBounds.x));
    const bh = Math.max(1, Math.abs(selectedBounds.y2 - selectedBounds.y));
    pctx.save();
    pctx.strokeStyle = 'rgba(17, 115, 255, 0.95)';
    pctx.lineWidth = 1.25;
    pctx.setLineDash([4, 3]);
    pctx.strokeRect(bx, by, bw, bh);
    pctx.setLineDash([]);
    if (Array.isArray(selectedHandles)) {
      for (const h of selectedHandles) {
        const active = activeHandleId && activeHandleId === h.id;
        pctx.beginPath();
        pctx.arc(h.x, h.y, active ? 4.8 : 4.1, 0, Math.PI * 2);
        pctx.fillStyle = active ? '#0b62e0' : '#1173ff';
        pctx.fill();
        pctx.strokeStyle = '#fff';
        pctx.lineWidth = 1.1;
        pctx.stroke();
      }
    }
    pctx.restore();
  }

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (rotateDeg === 90) {
    ctx.transform(0, -1, 1, 0, 0, pilW - 1);
  } else if (rotateDeg === 180) {
    ctx.transform(-1, 0, 0, -1, w - 1, h - 1);
  } else if (rotateDeg === 270) {
    ctx.transform(0, 1, -1, 0, pilH - 1, 0);
  }
  ctx.drawImage(scratch, 0, 0, pilW, pilH);
  canvas.__odPxToTag = ctx.getTransform().inverse();
  ctx.restore();
}
