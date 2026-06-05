/**
 * Designer power features: inspector, shortcuts, diff, blueprint.
 */

import { replaceRange } from './entity_autocomplete.js';

/** @type {Record<string, string[]>} */
export const INSPECTOR_FIELDS = {
  debug_grid: [
    'spacing',
    'line_color',
    'dashed',
    'dash_length',
    'space_length',
    'show_labels',
    'label_step',
    'label_color',
    'label_font_size',
    'font',
    'visible',
  ],
  text: [
    'x',
    'y',
    'value',
    'size',
    'font',
    'color',
    'anchor',
    'max_width',
    'spacing',
    'stroke_width',
    'stroke_fill',
    'y_padding',
    'visible',
    'parse_colors',
    'truncate',
  ],
  multiline: [
    'x',
    'y',
    'value',
    'delimiter',
    'offset_y',
    'size',
    'font',
    'color',
    'spacing',
    'visible',
    'parse_colors',
  ],
  line: [
    'x_start',
    'y_start',
    'x_end',
    'y_end',
    'fill',
    'width',
    'y_padding',
    'dashed',
    'dash_length',
    'space_length',
    'visible',
  ],
  rectangle: [
    'x_start',
    'y_start',
    'x_end',
    'y_end',
    'fill',
    'outline',
    'width',
    'radius',
    'corners',
    'visible',
  ],
  rectangle_pattern: [
    'x_start',
    'y_start',
    'x_size',
    'y_size',
    'x_offset',
    'y_offset',
    'x_repeat',
    'y_repeat',
    'fill',
    'outline',
    'width',
    'visible',
  ],
  polygon: ['points', 'fill', 'outline', 'width', 'visible'],
  circle: ['x', 'y', 'radius', 'fill', 'outline', 'width', 'visible'],
  ellipse: ['x_start', 'y_start', 'x_end', 'y_end', 'fill', 'outline', 'width', 'visible'],
  arc: ['x', 'y', 'radius', 'start_angle', 'end_angle', 'fill', 'outline', 'width', 'visible'],
  icon: ['x', 'y', 'value', 'size', 'fill', 'color', 'anchor', 'visible'],
  icon_sequence: [
    'x',
    'y',
    'icons',
    'size',
    'direction',
    'spacing',
    'fill',
    'anchor',
    'visible',
  ],
  dlimg: ['url', 'x', 'y', 'xsize', 'ysize', 'resize_method', 'rotate', 'visible'],
  qrcode: ['data', 'x', 'y', 'boxsize', 'border', 'color', 'bgcolor', 'visible'],
  qr_code: ['data', 'x', 'y', 'boxsize', 'border', 'color', 'bgcolor', 'visible'],
  plot: [
    'x_start',
    'y_start',
    'x_end',
    'y_end',
    'data',
    'duration',
    'low',
    'high',
    'font',
    'size',
    'round_values',
    'debug',
    'ylegend',
    'yaxis',
    'xlegend',
    'xaxis',
    'visible',
  ],
  progress_bar: [
    'x_start',
    'y_start',
    'x_end',
    'y_end',
    'progress',
    'direction',
    'background',
    'fill',
    'outline',
    'width',
    'show_percentage',
    'font',
    'visible',
  ],
  diagram: ['x', 'y', 'width', 'height', 'margin', 'bars', 'visible'],
};

const INSPECTOR_COLOR_KEYS = new Set([
  'color',
  'fill',
  'outline',
  'background',
  'bgcolor',
  'stroke_fill',
  'line_color',
  'label_color',
  'legend_color',
]);

/** Fields where bare entity ids are wrapped as {{ states('…') }} */
const INSPECTOR_ENTITY_KEYS = new Set([
  'value',
  'url',
  'progress',
  'color',
  'fill',
  'outline',
  'background',
  'stroke_fill',
  'legend_color',
]);

/**
 * @param {string} key
 * @param {string} elementType
 */
function fieldPlaceholder(key, elementType) {
  if (key === 'value') return "Hello or {{ states('sensor.time') }}";
  if (key === 'url') return "/local/image.png or {{ states('camera.x') }}";
  if (key === 'progress') return "62 or {{ states('sensor.battery') | int }}";
  if (INSPECTOR_COLOR_KEYS.has(key)) {
    return "black or {{ 'accent' if is_state('…') else 'black' }}";
  }
  if (key === 'data' && elementType === 'plot') {
    return '[{"entity":"sensor.temperature","color":"black","width":2}]';
  }
  if (key === 'data') return 'https://example.com or text';
  if (key === 'bars' && elementType === 'diagram') {
    return '{"values":"A,8;B,14;C,10","color":"black"}';
  }
  return '';
}

/**
 * @param {string} key
 * @param {string} elementType
 * @returns {Array<{ label: string; insert: string }> | null}
 */
function templateChipsForField(key, elementType) {
  if (key === 'value') {
    /** @type {Array<{ label: string; insert: string }>} */
    const chips = [
      { label: 'Entity', insert: "{{ states('') }}" },
      { label: 'Attribute', insert: "{{ state_attr('', '') }}" },
      { label: 'Condition', insert: "{{ is_state('', 'on') }}" },
    ];
    if (elementType === 'text' || elementType === 'multiline') {
      chips.push({ label: 'Accent', insert: '[accent][/accent]' });
    }
    return chips;
  }
  if (key === 'url' || key === 'progress') {
    return [
      { label: 'Entity', insert: "{{ states('') }}" },
      { label: 'Attribute', insert: "{{ state_attr('', '') }}" },
      { label: 'Condition', insert: "{{ is_state('', 'on') }}" },
    ];
  }
  if (INSPECTOR_COLOR_KEYS.has(key)) {
    return [
      { label: 'Entity', insert: "{{ states('') }}" },
      { label: 'Condition', insert: "{{ is_state('', 'on') }}" },
      { label: 'Conditional', insert: "{{ 'accent' if is_state('', 'on') else 'black' }}" },
    ];
  }
  return null;
}

/**
 * @param {HTMLElement} labelRow
 * @param {HTMLInputElement | HTMLTextAreaElement} inp
 * @param {Array<{ label: string; insert: string }>} chips
 */
function appendFieldTemplateChips(labelRow, inp, chips) {
  const row = document.createElement('span');
  row.className = 'od-inspector-field-chips';
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'od-tpl-chip';
    btn.textContent = chip.label;
    btn.title = chip.insert;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      inp.focus();
      const start = inp.selectionStart ?? inp.value.length;
      const end = inp.selectionEnd ?? start;
      replaceRange(inp, start, end, chip.insert);
    });
    row.appendChild(btn);
  }
  labelRow.appendChild(row);
}

const INSPECTOR_LONG_KEYS = new Set([
  'value',
  'data',
  'points',
  'icons',
  'bars',
  'ylegend',
  'yaxis',
  'xlegend',
  'xaxis',
]);

const INSPECTOR_JSON_KEYS = new Set([
  'data',
  'points',
  'icons',
  'bars',
  'ylegend',
  'yaxis',
  'xlegend',
  'xaxis',
]);

const INSPECTOR_BOOL_KEYS = new Set([
  'visible',
  'parse_colors',
  'truncate',
  'dashed',
  'show_labels',
  'show_percentage',
  'round_values',
  'debug',
]);

const INSPECTOR_NUMERIC_KEYS = new Set([
  'size',
  'offset_y',
  'width',
  'radius',
  'progress',
  'duration',
  'low',
  'high',
  'spacing',
  'boxsize',
  'border',
  'xsize',
  'ysize',
  'rotate',
  'margin',
  'height',
  'start_angle',
  'end_angle',
  'dash_length',
  'space_length',
  'label_step',
  'label_font_size',
  'x_repeat',
  'y_repeat',
  'x_size',
  'y_size',
  'x_offset',
  'y_offset',
  'stroke_width',
  'y_padding',
  'max_width',
]);

/** @param {unknown} v */
function isPlainColorValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return true;
  return !s.includes('{{') && !s.includes('{%') && !s.includes('[');
}

/**
 * @param {Record<string, unknown>} el
 * @param {string} key
 * @param {string} value
 */
export function applyInspectorFieldValue(el, key, value) {
  if (INSPECTOR_JSON_KEYS.has(key)) {
    const trimmed = value.trim();
    if (!trimmed) {
      delete el[key];
      return;
    }
    try {
      el[key] = JSON.parse(trimmed);
    } catch {
      el[key] = value;
    }
    return;
  }
  if (INSPECTOR_BOOL_KEYS.has(key)) {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === 'false') {
      el[key] = s === 'true';
      return;
    }
  }
  if (
    INSPECTOR_NUMERIC_KEYS.has(key) ||
    key === 'x' ||
    key === 'y' ||
    key.startsWith('x_') ||
    key.startsWith('y_')
  ) {
    const n = Number(value);
    el[key] = Number.isFinite(n) ? n : value;
    return;
  }
  el[key] = value;
}

export function resolveInspectorFields(type, item) {
  const known = INSPECTOR_FIELDS[type] || [];
  const seen = new Set(known);
  /** @type {string[]} */
  const extra = [];
  for (const key of Object.keys(item)) {
    if (key === 'type' || seen.has(key)) continue;
    seen.add(key);
    extra.push(key);
  }
  extra.sort();
  return [...known, ...extra];
}

/**
 * @param {unknown} v
 * @param {string} [key]
 * @param {string} [elementType]
 */
function fieldDisplayValue(v, key, elementType) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    try {
      if (key === 'data' && elementType === 'plot') {
        return JSON.stringify(v);
      }
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * @param {HTMLElement} panel
 * @param {number} idx
 * @param {Record<string, unknown> | null} item
 * @param {{ availableColors?: string[] }} [options]
 * @param {(idx: number, key: string, value: string) => void} onChange
 */
export function renderInspector(panel, idx, item, options, onChange) {
  panel.replaceChildren();
  if (!item || idx < 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const head = document.createElement('div');
  head.className = 'od-inspector-head';
  head.innerHTML = `<h3>Element ${idx + 1}</h3><span class="od-inspector-type">${String(item.type || '')}</span>`;
  panel.appendChild(head);

  const type = String(item.type || '').toLowerCase();

  const fields = resolveInspectorFields(type, item);
  const colors = options?.availableColors?.length ? options.availableColors : [];
  const form = document.createElement('div');
  form.className = 'od-inspector-form';
  for (const key of fields) {
    const field = document.createElement('label');
    field.className = 'od-inspector-field';
    const lab = document.createElement('span');
    lab.className = 'od-inspector-field-label';
    const keySpan = document.createElement('span');
    keySpan.className = 'od-inspector-field-key';
    keySpan.textContent = key;
    lab.appendChild(keySpan);
    const cur = fieldDisplayValue(item[key], key, type);
    const useColorSelect =
      INSPECTOR_COLOR_KEYS.has(key) && colors.length && isPlainColorValue(item[key]);
    if (useColorSelect) {
      const sel = document.createElement('select');
      const opts = [...colors];
      const curStr = String(item[key] ?? '');
      if (curStr && !opts.includes(curStr)) opts.unshift(curStr);
      for (const c of opts) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      }
      sel.value = curStr || colors[0] || '';
      sel.addEventListener('change', () => onChange(idx, key, sel.value));
      field.append(lab, sel);
    } else {
      const isLong = INSPECTOR_LONG_KEYS.has(key);
      const inp = isLong ? document.createElement('textarea') : document.createElement('input');
      if (isLong) {
        inp.rows = key === 'value' ? 3 : 4;
      } else {
        inp.type = 'text';
      }
      inp.value = cur;
      inp.dataset.odKey = key;
      const ph = fieldPlaceholder(key, type);
      if (ph) inp.placeholder = ph;
      if (INSPECTOR_ENTITY_KEYS.has(key)) inp.dataset.odAcEntity = '1';
      if (key === 'data' && type === 'plot') inp.dataset.odAcEntity = '0';
      if (INSPECTOR_COLOR_KEYS.has(key)) inp.dataset.odAcColors = '1';
      if (key === 'data' && type === 'plot') {
        inp.title = 'Entity IDs in JSON — type sensor. or Ctrl+Space';
      }
      const chips = templateChipsForField(key, type);
      if (chips) {
        appendFieldTemplateChips(lab, inp, chips);
        inp.title = 'Templates supported — type {{ or sensor., Ctrl+Space for suggestions';
      }
      inp.addEventListener('change', () => onChange(idx, key, inp.value));
      const wrap = document.createElement('div');
      wrap.className = 'od-inspector-field-wrap';
      wrap.appendChild(inp);
      field.append(lab, wrap);
    }
    form.appendChild(field);
  }
  panel.appendChild(form);

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'secondary od-inspector-jump';
  jump.textContent = 'Jump to YAML';
  jump.addEventListener('click', () => {
    panel.dispatchEvent(new CustomEvent('od-jump-yaml', { bubbles: true, detail: { idx } }));
  });
  panel.appendChild(jump);
}

/**
 * @param {HTMLElement} root
 * @param {(tab: string) => void} onTab
 */
export function setupWorkspaceTabs(root, onTab) {
  const tabs = root.querySelectorAll('.od-workspace-tabs [data-od-tab]');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = /** @type {HTMLElement} */ (btn).dataset.odTab || 'yaml';
      root.classList.remove('od-tab-yaml', 'od-tab-visual', 'od-tab-export');
      root.classList.add(`od-tab-${tab}`);
      tabs.forEach((b) => b.classList.toggle('active', b === btn));
      onTab(tab);
    });
  });
}

/**
 * @param {HTMLElement} shadow
 * @param {Record<string, string>} shortcuts
 */
export function setupShortcutsModal(shadow, shortcuts) {
  const backdrop = shadow.querySelector('#od-shortcuts-modal');
  const list = shadow.querySelector('#od-shortcuts-list');
  const closeBtn = shadow.querySelector('#od-shortcuts-close');
  if (!backdrop || !list) return { open: () => {}, close: () => {} };

  list.replaceChildren();
  for (const [key, desc] of Object.entries(shortcuts)) {
    const row = document.createElement('div');
    row.className = 'od-shortcut-row';
    row.innerHTML = `<kbd>${key}</kbd><span>${desc}</span>`;
    list.appendChild(row);
  }

  const close = () => {
    backdrop.hidden = true;
  };
  const open = () => {
    backdrop.hidden = false;
  };
  closeBtn?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  return { open, close };
}

/**
 * @param {HTMLElement} shadow
 * @param {() => string} getCurrentYaml
 * @param {() => string | null} getLastHaYaml
 */
export function setupDiffModal(shadow, getCurrentYaml, getLastHaYaml) {
  const backdrop = shadow.querySelector('#od-diff-modal');
  const body = shadow.querySelector('#od-diff-body');
  const closeBtn = shadow.querySelector('#od-diff-close');
  const openBtn = shadow.querySelector('#od-diff-open');
  if (!backdrop || !body) return { open: () => {}, close: () => {} };

  const close = () => {
    backdrop.hidden = true;
  };
  const open = () => {
    const left = getLastHaYaml() || '(no HA preview yet)';
    const right = getCurrentYaml();
    body.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'od-diff-columns';
    const colA = document.createElement('pre');
    colA.textContent = left;
    const colB = document.createElement('pre');
    colB.textContent = right;
    wrap.append(colA, colB);
    body.appendChild(wrap);
    backdrop.hidden = false;
  };
  closeBtn?.addEventListener('click', close);
  openBtn?.addEventListener('click', open);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  return { open, close };
}

/**
 * @param {string} payloadYamlIndented
 */
export function buildBlueprintSnippet(payloadYamlIndented) {
  return `blueprint:
  name: OpenDisplay drawcustom
  domain: automation
  input:
    device_id:
      name: OpenDisplay device
      selector:
        device:
          integration: opendisplay
    background:
      name: Background
      default: white
      selector:
        select:
          options:
            - white
            - black
            - accent
            - red
            - yellow
  source_url: https://github.com/OpenDisplay/Home_Assistant_Integration
variables:
  device_id: !input device_id
  background: !input background
trigger: []
action:
  - action: opendisplay.drawcustom
    target:
      device_id: "{{ device_id }}"
    data:
      background: !input background
      rotate: 0
      dither: ordered
      refresh_type: full
      dry-run: false
      payload:
${payloadYamlIndented}
`;
}
