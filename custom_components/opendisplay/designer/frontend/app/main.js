import yaml from '../vendor/js-yaml.mjs';
import { formatPayloadYamlList, normalizePayloadYamlInput } from './yaml_util.js';
import { setupYamlGutter } from './yaml_gutter.js';
import {
  renderInspector,
  applyInspectorFieldValue,
  setupWorkspaceTabs,
  setupShortcutsModal,
  setupDiffModal,
} from './designer_extras.js';
import {
  setupEntityAutocomplete,
  setupInspectorAutocomplete,
  resolvePlotDataEntities,
} from './entity_autocomplete.js';
import {
  VIRTUAL_DEVICE_ID,
  COLOR_FALLBACK,
  listOpenDisplayDevices,
  parsePositiveInt,
  resolveTagPx,
  availableDisplayColors,
  colorChipHex,
  dimensionsFromImageEntity,
} from './dimensions.js';
import { rebuildExportSnippet, copyExportSnippet, copyBlueprintSnippet } from './export.js';
import { createPreviewRuntime } from './preview.js';
import {
  KNOWN_ELEMENT_TYPES,
  setupPaletteChips,
  attachSketchEditor,
} from './sketch_edit.js';

/** @typedef {{ setHass: (h:any)=>void; destroy: ()=>void }} MountResult */

const HISTORY_LIMIT = 80;

/** @param {unknown} err */
function errMsg(err) {
  if (err && typeof err === 'object') {
    const message = Reflect.get(err, 'message');
    const code = Reflect.get(err, 'code');
    const body = Reflect.get(err, 'body');
    let bodyStr = '';
    if (body && typeof body === 'object' && body.message) {
      bodyStr = String(body.message);
    }
    return (
      [typeof message === 'string' ? message : '', bodyStr].filter(Boolean).join(' — ') ||
      (typeof code === 'string' ? code : 'Error')
    );
  }
  return String(err);
}

function parsePayloadYaml(text) {
  const normalized = normalizePayloadYamlInput(text);
  const doc = yaml.load(normalized || '[]');
  if (!Array.isArray(doc)) {
    throw new Error('Payload must be a YAML list (array) of draw elements');
  }
  return doc;
}

/**
 * @param {HTMLElement} host
 * @param {any} initialHass
 * @returns {MountResult}
 */
export function mountDesigner(host, initialHass) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.replaceChildren();

  const root = document.createElement('div');
  root.className = 'od-root';
  root.innerHTML = `
    <div class="od-toolbar od-card">
      <div class="od-field compact-bot">
        <select id="od-device"></select>
      </div>
      <div class="od-virtual-size" id="od-virtual-size">
        <label for="od-virtual-w">W</label>
        <input id="od-virtual-w" type="number" min="16" max="4096" value="296" />
        <label for="od-virtual-h">H</label>
        <input id="od-virtual-h" type="number" min="16" max="4096" value="128" />
      </div>
    </div>
    <nav class="od-workspace-tabs" aria-label="Workspace">
      <button type="button" class="active" data-od-tab="yaml">YAML</button>
      <button type="button" data-od-tab="visual">Visual</button>
      <button type="button" data-od-tab="export">Export</button>
    </nav>
    <div class="od-main">
      <div class="od-col od-card od-col-edit" data-od-panel="yaml">
        <h2>Payload (YAML)</h2>
        <div class="od-editor-shell" id="od-editor-shell">
          <div class="od-editor-gutter" id="od-gutter" aria-hidden="true"></div>
          <div class="od-editor-wrap">
            <textarea id="od-payload" class="od-payload-ta" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="drawcustom YAML payload"></textarea>
          </div>
        </div>
        <p id="od-parse-status" class="od-parse-status" hidden></p>
        <div id="od-diagnostics" class="od-diagnostics" hidden></div>
        <div class="od-actions od-actions-bar od-actions-sticky">
          <div class="od-actions-group od-actions-history">
            <button type="button" class="secondary" id="od-undo" title="Undo (Ctrl/Cmd+Z)">Undo</button>
            <button type="button" class="secondary" id="od-redo" title="Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)">Redo</button>
          </div>
          <div class="od-actions-group od-actions-tools">
            <button type="button" class="secondary" id="od-diff-open" title="Compare to last HA preview">Diff</button>
            <button type="button" class="secondary" id="od-shortcuts-open" title="Keyboard shortcuts (?)">?</button>
          </div>
          <div class="od-actions-group od-actions-primary">
            <button type="button" id="od-preview" title="Render via Home Assistant dry-run">Preview</button>
            <button type="button" id="od-send" title="Send rendered image to the tag">Send</button>
          </div>
        </div>
      </div>
      <div class="od-col od-card od-col-visual" data-od-panel="visual">
        <div class="od-visual-stack">
          <div class="od-visual-layout">
            <div class="od-visual-panel od-combined">
            <div class="od-preview-head">
              <h3>Preview</h3>
              <div class="od-color-swatches" id="od-color-swatches" aria-label="Available display colors"></div>
              <div class="od-preview-modes" role="radiogroup" aria-label="Preview layout">
                <label><input type="radio" name="od-pvm" value="sketch" checked /> Sketch</label>
                <label><input type="radio" name="od-pvm" value="overlay" /> Overlay</label>
                <label><input type="radio" name="od-pvm" value="ha" /> HA</label>
                <label><input type="radio" name="od-pvm" value="split" /> Split</label>
              </div>
            </div>
            <div class="od-palette" id="od-palette-root">
              <span class="od-palette-label">Add</span>
            </div>
            <div class="od-preview-frame od-combined-frame pvm-sketch" id="od-preview-frame">
              <span class="od-muted od-preview-placeholder" id="od-preview-placeholder">Select device; auto-preview runs after edits when enabled.</span>
              <div class="od-split-label od-split-label-sketch">Sketch</div>
              <div class="od-split-label od-split-label-ha">HA render</div>
              <img id="od-preview-img" alt="Home Assistant rendered image" hidden />
              <canvas id="od-sketch" width="296" height="128" aria-label="Sketch preview"></canvas>
            </div>
            <p id="od-ha-stale-hint" class="od-ha-stale-hint" hidden>
              Underlying HA bitmap is older than your YAML — use Preview or wait for auto dry-run.
            </p>
            <div id="od-ha-status" class="od-ha-status"></div>
            </div>
            <aside class="od-inspector od-card" id="od-inspector" hidden aria-label="Element inspector"></aside>
          </div>
        </div>
        <details class="od-details od-export-panel" data-od-panel="export">
          <summary>Service options & export</summary>
          <div class="od-field">
            <label for="od-bg">background</label>
            <select id="od-bg">
              <option>white</option><option>black</option><option>accent</option><option>red</option><option>yellow</option>
            </select>
          </div>
          <div class="od-row-inline">
            <div class="od-field">
              <label for="od-rot">rotate</label>
              <select id="od-rot">
                <option value="0">0</option><option value="90">90</option><option value="180">180</option><option value="270">270</option>
              </select>
            </div>
            <div class="od-field">
              <label for="od-dither">dither</label>
              <select id="od-dither">
                <option value="none">none</option>
                <option value="ordered" selected>ordered</option>
                <option value="floyd_steinberg">floyd_steinberg</option>
                <option value="burkes">burkes</option>
                <option value="atkinson">atkinson</option>
                <option value="stucki">stucki</option>
                <option value="sierra">sierra</option>
                <option value="sierra_lite">sierra_lite</option>
                <option value="jarvis_judice_ninke">jarvis_judice_ninke</option>
              </select>
            </div>
          </div>
          <div class="od-field">
            <label for="od-refresh">refresh_type</label>
            <select id="od-refresh">
              <option value="full" selected>full</option>
              <option value="fast">fast</option>
            </select>
          </div>
          <div class="od-export-actions">
            <button type="button" class="secondary" id="od-copy">Copy automation YAML</button>
            <button type="button" class="secondary" id="od-blueprint">Copy blueprint</button>
          </div>
          <pre class="od-export" id="od-export"></pre>
        </details>
      </div>
    </div>
    <div class="od-modal-backdrop" id="od-shortcuts-modal" hidden>
      <div class="od-modal" role="dialog" aria-labelledby="od-shortcuts-title">
        <h3 id="od-shortcuts-title">Keyboard shortcuts</h3>
        <div id="od-shortcuts-list"></div>
        <button type="button" class="secondary" id="od-shortcuts-close">Close</button>
      </div>
    </div>
    <div class="od-modal-backdrop" id="od-diff-modal" hidden>
      <div class="od-modal od-modal-wide" role="dialog" aria-labelledby="od-diff-title">
        <h3 id="od-diff-title">Diff vs last HA preview</h3>
        <p class="od-muted">Shows resolved payload from last successful Preview vs current editor YAML.</p>
        <div class="od-diff-body" id="od-diff-body"></div>
        <button type="button" class="secondary" id="od-diff-close">Close</button>
      </div>
    </div>
  `;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./styles.css', import.meta.url).href;
  shadow.append(link, root);

  /** @type {any} */
  let hass = initialHass;
  const $ = /** @type {(s:string)=>HTMLElement} */ (sel) =>
    /** @type {HTMLElement} */ (shadow.querySelector(sel));

  const previewFrame = /** @type {HTMLElement} */ ($('#od-preview-frame'));
  const sketchCanvas = /** @type {HTMLCanvasElement} */ ($('#od-sketch'));
  const previewImgEl = /** @type {HTMLImageElement} */ ($('#od-preview-img'));
  const colorSwatchesEl = /** @type {HTMLElement} */ ($('#od-color-swatches'));
  const virtualSizeWrap = /** @type {HTMLElement} */ ($('#od-virtual-size'));
  const virtualWInput = /** @type {HTMLInputElement} */ ($('#od-virtual-w'));
  const virtualHInput = /** @type {HTMLInputElement} */ ($('#od-virtual-h'));
  const sendBtn = /** @type {HTMLButtonElement} */ ($('#od-send'));
  const taPayload = /** @type {HTMLTextAreaElement} */ ($('#od-payload'));
  const editorShell = /** @type {HTMLElement} */ ($('#od-editor-shell'));

  setupPaletteChips(/** @type {HTMLElement} */ ($('#od-palette-root')));

  taPayload.value = `- type: text
  value: Hello World!
  x: 0
  y: 0
  size: 40
  color: black
`;

  let lastValidPayload = /** @type {unknown[] | null} */ (null);
  let lastParseError = /** @type {string | null} */ (null);
  let cachedAvailableColors = [...COLOR_FALLBACK];
  let undoStack = /** @type {string[]} */ ([]);
  let redoStack = /** @type {string[]} */ ([]);
  let suppressHistoryCapture = false;
  /** @type {ReturnType<typeof setupInspectorAutocomplete> | null} */
  let inspectorAc = null;

  const state = {
    sketchDebounceTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
    haPreviewDebounceTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
    haGeneration: 0,
    haDryApplyTicket: 0,
    yamlPreviewBump: 0,
    pendingAutoHaBumpTarget: /** @type {number | null} */ (null),
    haBmpReflectsYamlBump: /** @type {number | null} */ (null),
    selectedItemIdx: -1,
    lastHaPreviewPayloadYaml: /** @type {string | null} */ (null),
    sketchEdit: /** @type {null | {
      pointerId: number;
      mode: 'move' | 'resize';
      idx: number;
      lastTx: number;
      lastTy: number;
      handle?: { id: string; kind: string; x: number; y: number; vertexIndex?: number } | null;
    }} */ (null),
  };

  function getHass() {
    return hass;
  }

  function effectiveDeviceId() {
    return /** @type {HTMLSelectElement} */ ($('#od-device')).value;
  }

  function isVirtualDeviceSelected() {
    return effectiveDeviceId() === VIRTUAL_DEVICE_ID;
  }

  function getTagPx() {
    const meta = resolveTagPx(hass, effectiveDeviceId(), previewImgEl, {
      w: parsePositiveInt(virtualWInput.value),
      h: parsePositiveInt(virtualHInput.value),
    });
    return { tagW: meta.tagW, tagH: meta.tagH };
  }

  function showToast(msg, isErr) {
    const t = document.createElement('div');
    t.className = `od-toast${isErr ? ' err' : ''}`;
    t.textContent = msg;
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  function refreshBackgroundSelect() {
    const sel = /** @type {HTMLSelectElement} */ ($('#od-bg'));
    const cur = sel.value;
    const colors = availableDisplayColors(hass, effectiveDeviceId());
    sel.replaceChildren();
    for (const c of colors) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    }
    if (colors.includes(cur)) sel.value = cur;
    else if (colors.includes('white')) sel.value = 'white';
    else if (colors.length) sel.value = colors[0];
  }

  function refreshColorSwatches() {
    cachedAvailableColors = availableDisplayColors(hass, effectiveDeviceId());
    refreshBackgroundSelect();
    colorSwatchesEl.replaceChildren();
    const devId = effectiveDeviceId();
    for (const c of cachedAvailableColors) {
      const chip = document.createElement('span');
      chip.className = 'od-color-chip';
      chip.title = c;
      chip.setAttribute('aria-label', c);
      chip.style.background = colorChipHex(c, hass, devId);
      if (c === 'white') chip.style.borderColor = 'rgba(0,0,0,0.35)';
      colorSwatchesEl.appendChild(chip);
    }
    if (state.selectedItemIdx >= 0) updateSelectionUi();
  }

  function refreshDeviceSelect() {
    const sel = /** @type {HTMLSelectElement} */ ($('#od-device'));
    const devices = listOpenDisplayDevices(hass);
    const cur = sel.value;
    sel.innerHTML = '';
    if (devices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No OpenDisplay devices in the registry';
      sel.appendChild(opt);
      const virt = document.createElement('option');
      virt.value = VIRTUAL_DEVICE_ID;
      virt.textContent = 'Virtual device (local sketch)';
      sel.appendChild(virt);
      return;
    }
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      sel.appendChild(opt);
    }
    if (cur && devices.some((d) => d.id === cur)) sel.value = cur;
  }

  function refreshDeviceUiMode() {
    const isVirtual = isVirtualDeviceSelected();
    virtualWInput.disabled = !isVirtual;
    virtualHInput.disabled = !isVirtual;
    virtualSizeWrap.classList.toggle('is-locked', !isVirtual);
    sendBtn.hidden = isVirtual;
    if (isVirtual) $('#od-ha-status').textContent = 'Virtual mode: local sketch only.';
    refreshColorSwatches();
  }

  function syncDimensionInputsFromSelectedDevice() {
    const devId = effectiveDeviceId();
    if (!devId || devId === VIRTUAL_DEVICE_ID) return;
    const dims = dimensionsFromImageEntity(hass, devId);
    if (!dims) return;
    virtualWInput.value = String(dims.tagW);
    virtualHInput.value = String(dims.tagH);
  }

  function silentParsePayload() {
    try {
      return parsePayloadYaml(taPayload.value);
    } catch {
      return null;
    }
  }

  function collectPayloadDiagnostics(parsed) {
    /** @type {{ level:'error'|'warn'; message:string }[]} */
    const out = [];
    if (!Array.isArray(parsed)) {
      out.push({ level: 'error', message: 'Payload is not a YAML list.' });
      return out;
    }
    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        out.push({ level: 'error', message: `Item ${i + 1}: must be an object.` });
        continue;
      }
      const rec = /** @type {Record<string, unknown>} */ (item);
      const type = String(rec.type || '').trim().toLowerCase();
      if (!type) {
        out.push({ level: 'error', message: `Item ${i + 1}: missing type.` });
        continue;
      }
      if (!KNOWN_ELEMENT_TYPES.has(type)) {
        out.push({
          level: 'warn',
          message: `Item ${i + 1}: unknown type "${type}" (preview fallback only).`,
        });
      }
      if ((type === 'text' || type === 'multiline') && !String(rec.value ?? '').trim()) {
        out.push({ level: 'warn', message: `Item ${i + 1}: ${type} has empty value.` });
      }
    }
    return out;
  }

  function renderDiagnostics(diags) {
    const box = /** @type {HTMLElement} */ ($('#od-diagnostics'));
    box.replaceChildren();
    if (!Array.isArray(diags) || diags.length === 0) {
      box.hidden = true;
      yamlGutter?.refresh();
      return;
    }
    box.hidden = false;
    const title = document.createElement('strong');
    title.textContent = `Diagnostics (${diags.length})`;
    box.appendChild(title);
    for (const d of diags) {
      const line = document.createElement('div');
      line.className = `od-diag-item od-diag-${d.level === 'warn' ? 'warn' : 'err'}`;
      line.textContent = d.message;
      box.appendChild(line);
    }
    yamlGutter?.refresh();
  }

  function validatePayload() {
    const status = /** @type {HTMLElement} */ ($('#od-parse-status'));
    const raw = taPayload.value.replace(/\r\n/g, '\n');
    const normalized = normalizePayloadYamlInput(raw);
    if (normalized !== raw.trim()) {
      suppressHistoryCapture = true;
      taPayload.value = normalized ? `${normalized}\n` : '';
      suppressHistoryCapture = false;
    }
    try {
      const arr = parsePayloadYaml(taPayload.value);
      lastValidPayload = arr;
      lastParseError = null;
      status.hidden = true;
      status.textContent = '';
      renderDiagnostics(collectPayloadDiagnostics(arr));
      yamlGutter?.refresh();
      return true;
    } catch (e) {
      lastValidPayload = null;
      lastParseError = errMsg(e);
      status.textContent = lastParseError || 'Invalid YAML';
      status.hidden = false;
      renderDiagnostics([{ level: 'error', message: status.textContent || 'Invalid YAML' }]);
      yamlGutter?.refresh();
      return false;
    }
  }

  function updateUndoRedoUi() {
    /** @type {HTMLButtonElement} */ ($('#od-undo')).disabled = undoStack.length <= 1;
    /** @type {HTMLButtonElement} */ ($('#od-redo')).disabled = redoStack.length === 0;
  }

  function pushUndoSnapshot(rawYaml) {
    if (suppressHistoryCapture) return;
    const current = String(rawYaml ?? '');
    if (undoStack.length > 0 && undoStack[undoStack.length - 1] === current) return;
    undoStack.push(current);
    if (undoStack.length > HISTORY_LIMIT) {
      undoStack = undoStack.slice(undoStack.length - HISTORY_LIMIT);
    }
    redoStack = [];
    updateUndoRedoUi();
  }

  function applyYamlTextSnapshot(yamlText, reason = '') {
    suppressHistoryCapture = true;
    taPayload.value = yamlText;
    suppressHistoryCapture = false;
    lastValidPayload = null;
    lastParseError = null;
    validatePayload();
    rebuildExportSnippet(exportDeps);
    preview.scheduleRedrawSketch();
    preview.scheduleDebouncedHaPreview();
    if (reason) $('#od-ha-status').textContent = reason;
  }

  function undoPayloadEdit() {
    if (undoStack.length <= 1) return;
    const current = undoStack.pop();
    if (current != null) redoStack.push(current);
    applyYamlTextSnapshot(undoStack[undoStack.length - 1] || '', 'Undo applied.');
    updateUndoRedoUi();
  }

  function redoPayloadEdit() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    if (next == null) return;
    undoStack.push(next);
    applyYamlTextSnapshot(next, 'Redo applied.');
    updateUndoRedoUi();
  }

  function applyEditedPayload(parsed) {
    taPayload.value = formatPayloadYamlList(parsed);
    lastValidPayload = null;
    lastParseError = null;
    /** @type {HTMLElement} */ ($('#od-parse-status')).hidden = true;
    $('#od-parse-status').textContent = '';
    preview.bumpYamlPreviewGenOnly();
    pushUndoSnapshot(taPayload.value);
    updateUndoRedoUi();
    rebuildExportSnippet(exportDeps);
    preview.scheduleRedrawSketch();
    preview.scheduleDebouncedHaPreview();
    renderDiagnostics(collectPayloadDiagnostics(parsed));
  }

  function updateSelectionUi() {
    const parsed = silentParsePayload();
    const inspectorEl = /** @type {HTMLElement} */ ($('#od-inspector'));
    const item =
      parsed && state.selectedItemIdx >= 0 && state.selectedItemIdx < parsed.length
        ? /** @type {Record<string, unknown>} */ (parsed[state.selectedItemIdx])
        : null;
    renderInspector(
      inspectorEl,
      state.selectedItemIdx,
      item,
      { availableColors: cachedAvailableColors },
      (idx, key, value) => {
        const p = silentParsePayload();
        if (!p || idx < 0 || idx >= p.length) return;
        const el = /** @type {Record<string, unknown>} */ (p[idx]);
        applyInspectorFieldValue(el, key, value);
        applyEditedPayload(p);
        validatePayload();
      }
    );
    inspectorAc?.hide();
    inspectorAc = setupInspectorAutocomplete(inspectorEl, getHass, {
      getColorSuggestions: () => cachedAvailableColors,
    });
    if (state.selectedItemIdx >= 0) yamlGutter?.scrollToItem(state.selectedItemIdx);
    preview.scheduleRedrawSketch();
  }

  const exportDeps = {
    $,
    effectiveDeviceId,
    silentParsePayload,
    showToast,
  };

  const preview = createPreviewRuntime({
    shadow,
    previewFrame,
    previewImgEl,
    getTagPx,
    getHass,
    effectiveDeviceId,
    isVirtualDeviceSelected,
    silentParsePayload,
    lastParseError: () => lastParseError,
    lastValidPayload: () => lastValidPayload,
    validatePayload,
    showToast,
    $,
    state,
  });

  const sketch = attachSketchEditor({
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
    leaveHaForEdit: preview.leaveHaForEdit,
    scheduleRedrawSketch: preview.scheduleRedrawSketch,
    state,
  });

  const yamlGutter = setupYamlGutter(editorShell, taPayload, () => ({
    text: taPayload.value,
    diags: lastValidPayload ? collectPayloadDiagnostics(lastValidPayload) : [],
    parseError: lastParseError,
  }));

  setupEntityAutocomplete(wrapForAc(), taPayload, () => hass, {
    getColorSuggestions: () => cachedAvailableColors,
  });

  function wrapForAc() {
    return /** @type {HTMLElement} */ (shadow.querySelector('.od-editor-wrap'));
  }

  setupWorkspaceTabs(root, (tab) => {
    if (tab === 'export') /** @type {HTMLDetailsElement} */ ($('.od-export-panel')).open = true;
  });

  const shortcutsModal = setupShortcutsModal(shadow, {
    '?': 'Show keyboard shortcuts',
    'Ctrl/Cmd+Z': 'Undo',
    'Ctrl/Cmd+Shift+Z / Ctrl+Y': 'Redo',
    'Ctrl/Cmd+Space': 'Autocomplete — YAML editor & inspector fields',
    Escape: 'Clear selection',
  });

  setupDiffModal(shadow, () => taPayload.value, () => state.lastHaPreviewPayloadYaml);

  $('#od-inspector').addEventListener('od-jump-yaml', (ev) => {
    const idx = /** @type {CustomEvent} */ (ev).detail?.idx;
    if (typeof idx === 'number') yamlGutter?.scrollToItem(idx);
  });

  $('#od-shortcuts-open').addEventListener('click', () => shortcutsModal.open());
  $('#od-blueprint').addEventListener('click', () => copyBlueprintSnippet(exportDeps));
  $('#od-copy').addEventListener('click', () => copyExportSnippet(exportDeps));

  shadow.querySelectorAll('input[name="od-pvm"]').forEach((el) => {
    el.addEventListener('change', () => {
      preview.syncPreviewFrameClass();
      preview.redrawSketch();
    });
  });

  taPayload.addEventListener('input', () => {
    if (!suppressHistoryCapture) pushUndoSnapshot(taPayload.value);
    updateUndoRedoUi();
    preview.bumpYamlPreviewGenOnly();
    lastValidPayload = null;
    lastParseError = null;
    validatePayload();
    rebuildExportSnippet(exportDeps);
    preview.scheduleDebouncedHaPreview();
  });

  taPayload.addEventListener('keydown', (e) => {
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      shortcutsModal.open();
      e.preventDefault();
      return;
    }
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (ctrlOrMeta && !e.altKey) {
      const key = String(e.key || '').toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoPayloadEdit();
        return;
      }
      if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redoPayloadEdit();
        return;
      }
    }
    if (e.key === 'Escape') {
      sketch.clearSelection();
      preview.scheduleRedrawSketch();
    }
  });

  $('#od-preview').addEventListener('click', () =>
    void preview.interactiveDrawcustom(true).catch(() => {})
  );
  $('#od-send').addEventListener('click', () => {
    if (!window.confirm('Push this image to the tag (real update)?')) return;
    void preview.interactiveDrawcustom(false).catch(() => {});
  });
  $('#od-undo').addEventListener('click', undoPayloadEdit);
  $('#od-redo').addEventListener('click', redoPayloadEdit);

  previewImgEl.addEventListener('load', () => {
    preview.onPreviewImageLoad();
    refreshColorSwatches();
  });
  previewImgEl.addEventListener('error', () => {
    state.pendingAutoHaBumpTarget = null;
  });

  $('#od-device').addEventListener('change', () => {
    sketch.clearSelection();
    preview.clearHaDryRunPreview();
    refreshDeviceUiMode();
    syncDimensionInputsFromSelectedDevice();
    state.haDryApplyTicket += 1;
    refreshColorSwatches();
    rebuildExportSnippet(exportDeps);
    preview.scheduleRedrawSketch();
    preview.scheduleDebouncedHaPreview();
  });

  ['#od-bg', '#od-dither', '#od-refresh'].forEach((id) => {
    shadow.querySelector(id)?.addEventListener('change', () => {
      rebuildExportSnippet(exportDeps);
      preview.scheduleRedrawSketch();
      preview.scheduleDebouncedHaPreview();
    });
  });

  shadow.querySelector('#od-rot')?.addEventListener('change', () => {
    sketch.clearSelection();
    rebuildExportSnippet(exportDeps);
    preview.scheduleRedrawSketch();
    preview.scheduleDebouncedHaPreview();
  });

  [virtualWInput, virtualHInput].forEach((inp) => {
    inp.addEventListener('input', () => {
      if (!isVirtualDeviceSelected()) return;
      refreshColorSwatches();
      preview.scheduleRedrawSketch();
      rebuildExportSnippet(exportDeps);
    });
  });

  const HA_THEME_VARS = [
    '--primary-background-color',
    '--primary-text-color',
    '--secondary-background-color',
    '--secondary-text-color',
    '--card-background-color',
    '--divider-color',
    '--disabled-text-color',
    '--error-color',
    '--accent-color',
  ];

  function syncHaTheme() {
    const src = getComputedStyle(document.documentElement);
    for (const name of HA_THEME_VARS) {
      const val = src.getPropertyValue(name).trim();
      if (val) host.style.setProperty(name, val);
    }
    const dark = Boolean(
      hass?.themes?.darkMode ??
        hass?.selectedTheme?.dark ??
        document.documentElement.classList.contains('dark-mode')
    );
    host.style.colorScheme = dark ? 'dark' : 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.classList.toggle('od-ha-dark', dark);
    root.classList.toggle('od-ha-light', !dark);
  }

  function onHass() {
    syncHaTheme();
    refreshDeviceSelect();
    refreshDeviceUiMode();
    syncDimensionInputsFromSelectedDevice();
    refreshColorSwatches();
    rebuildExportSnippet(exportDeps);
    preview.redrawSketch();
  }

  const setHass = (h) => {
    hass = h;
    onHass();
  };

  root.classList.add('od-tab-yaml');
  syncHaTheme();
  setHass(hass);
  pushUndoSnapshot(taPayload.value);
  updateUndoRedoUi();
  validatePayload();
  yamlGutter?.refresh();
  updateSelectionUi();

  const previewResizeRo = new ResizeObserver(() => preview.scheduleRedrawSketch());
  previewResizeRo.observe(previewFrame);

  preview.syncPreviewFrameClass();
  preview.refreshPreviewPlaceholderVisibility();

  requestAnimationFrame(() => {
    syncDimensionInputsFromSelectedDevice();
    rebuildExportSnippet(exportDeps);
    preview.scheduleDebouncedHaPreview();
  });

  return {
    setHass,
    destroy() {
      previewResizeRo.disconnect();
      if (state.sketchDebounceTimer) clearTimeout(state.sketchDebounceTimer);
      if (state.haPreviewDebounceTimer) clearTimeout(state.haPreviewDebounceTimer);
      shadow.replaceChildren();
    },
  };
}
