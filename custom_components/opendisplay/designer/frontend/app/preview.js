import {
  paintPayloadSketch,
  computePreviewCssSize,
  computeSplitPreviewLayout,
  resolvePayloadForDryRun,
} from './preview_sketch.js';
import { formatPayloadYamlList } from './yaml_util.js';
import { imageEntityForDevice, dimensionsFromPreviewImage } from './dimensions.js';
import { readServiceData } from './export.js';
import { estimateItemBounds, getResizeHandles } from './sketch_hit.js';

/** @param {string} entityId */
export function imageServePath(entityId) {
  return `/api/image/serve/${entityId}`;
}

/**
 * Resolve entity_picture from latest hass snapshot (panel setHass updates this).
 * @param {() => any} getHass
 * @param {string} entityId
 */
export function entityPicturePath(getHass, entityId) {
  const pic = getHass()?.states?.[entityId]?.attributes?.entity_picture;
  if (pic && String(pic).trim()) return String(pic);
  return imageServePath(entityId);
}

/**
 * Wait for entity_picture URL to change in hass state (fallback only).
 * @param {() => any} getHass
 */
export async function waitForPictureChange(getHass, entityId, prevPic, timeoutMs = 1500) {
  const sleep = (/** @type {number} */ ms) =>
    new Promise((/** @type {(v: void) => void} */ r) => setTimeout(r, ms));
  const t0 = Date.now();
  let delay = 0;
  while (Date.now() - t0 < timeoutMs) {
    const pic = getHass()?.states?.[entityId]?.attributes?.entity_picture;
    if (pic && pic !== prevPic) return pic;
    await sleep(delay);
    delay = Math.min(48, delay + 16);
  }
  const pic = getHass()?.states?.[entityId]?.attributes?.entity_picture;
  return pic && String(pic).trim() ? pic : '';
}

/** @param {unknown} err */
export function errMsg(err) {
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

/** @param {Record<string, any>} deps */
export function createPreviewRuntime(deps) {
  const {
    shadow,
    previewFrame,
    previewImgEl,
    getTagPx,
    getHass,
    effectiveDeviceId,
    isVirtualDeviceSelected,
    silentParsePayload,
    lastParseError,
    showToast,
    $,
    state,
  } = deps;

  /** @returns {'sketch' | 'overlay' | 'ha' | 'split'} */
  function getPreviewMode() {
    const el = shadow.querySelector('input[name="od-pvm"]:checked');
    const v = el ? /** @type {HTMLInputElement} */ (el).value : 'sketch';
    if (v === 'overlay' || v === 'ha' || v === 'split') return v;
    return 'sketch';
  }

  function previewImageHasSrc() {
    const s = previewImgEl.getAttribute('src');
    return !!(s && s.trim());
  }

  function refreshHaStaleUi() {
    const hint =
      /** @type {HTMLElement | null} */ (shadow.querySelector('#od-ha-stale-hint'));
    const mode = getPreviewMode();
    const hasBmp = previewImageHasSrc();
    const ref =
      state.haBmpReflectsYamlBump !== null &&
      typeof state.haBmpReflectsYamlBump === 'number' &&
      !Number.isNaN(/** @type {number} */ (state.haBmpReflectsYamlBump));
    const stale =
      mode === 'overlay' &&
      hasBmp &&
      ref &&
      state.yamlPreviewBump !== /** @type {number} */ (state.haBmpReflectsYamlBump);
    previewFrame.classList.toggle('od-overlay-ha-stale', stale);
    if (hint) hint.hidden = !stale;
  }

  function refreshPreviewPlaceholderVisibility() {
    const ph = $('#od-preview-placeholder');
    const mode = getPreviewMode();
    ph.hidden =
      mode === 'sketch' ||
      ((mode === 'overlay' || mode === 'ha' || mode === 'split') && previewImageHasSrc());
  }

  function syncPreviewFrameClass() {
    previewFrame.classList.remove(
      'pvm-sketch',
      'pvm-overlay',
      'pvm-ha',
      'pvm-split',
      'od-overlay-ha-stale'
    );
    previewFrame.classList.add(`pvm-${getPreviewMode()}`);
    refreshPreviewPlaceholderVisibility();
    refreshHaStaleUi();
  }

  function layoutPreviewDims() {
    const fromImg = dimensionsFromPreviewImage(previewImgEl);
    if (fromImg) return fromImg;
    return getTagPx();
  }

  function applyCombinedPreviewLayout() {
    const { tagW, tagH } = layoutPreviewDims();
    previewFrame.classList.remove('od-split-cols', 'od-split-rows');
    if (getPreviewMode() === 'split') {
      const split = computeSplitPreviewLayout(previewFrame, tagW, tagH);
      previewFrame.classList.add(
        split.direction === 'columns' ? 'od-split-cols' : 'od-split-rows'
      );
      previewFrame.style.setProperty('--od-preview-w', `${split.cssW}px`);
      previewFrame.style.setProperty('--od-preview-h', `${split.cssH}px`);
      return { tagW, tagH, cssW: split.cssW, cssH: split.cssH };
    }
    const { cssW, cssH } = computePreviewCssSize(previewFrame, tagW, tagH);
    previewFrame.style.setProperty('--od-preview-w', `${cssW}px`);
    previewFrame.style.setProperty('--od-preview-h', `${cssH}px`);
    return { tagW, tagH, cssW, cssH };
  }

  function drawSketchMessage(canvas, msg) {
    const { cssW, cssH } = applyCombinedPreviewLayout();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    delete canvas.__odPxToTag;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#666';
    ctx.font = '13px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, cssW / 2, cssH / 2);
  }

  function scheduleRedrawSketch() {
    if (state.sketchDebounceTimer) clearTimeout(state.sketchDebounceTimer);
    state.sketchDebounceTimer = setTimeout(redrawSketch, 90);
  }

  function redrawSketch() {
    state.sketchDebounceTimer = null;
    const canvas = /** @type {HTMLCanvasElement} */ (shadow.querySelector('#od-sketch'));
    const parsed = silentParsePayload();
    if (!parsed) {
      state.selectedItemIdx = -1;
      drawSketchMessage(canvas, lastParseError() || 'Invalid YAML');
      return;
    }
    if (state.selectedItemIdx >= parsed.length) state.selectedItemIdx = -1;
    const { tagW, tagH, cssW, cssH } = applyCombinedPreviewLayout();
    const bg = /** @type {HTMLSelectElement} */ ($('#od-bg')).value;
    const rot = Number(/** @type {HTMLSelectElement} */ ($('#od-rot')).value);
    const mode = getPreviewMode();
    const hass = getHass();
    let selectedBounds = null;
    let selectedHandles = null;
    let activeHandleId = null;
    if (
      state.selectedItemIdx >= 0 &&
      state.selectedItemIdx < parsed.length
    ) {
      const selected = parsed[state.selectedItemIdx];
      selectedBounds = estimateItemBounds(selected, hass, tagW, tagH);
      selectedHandles = getResizeHandles(selected, hass, tagW, tagH);
      activeHandleId = state.sketchEdit?.handle?.id ?? null;
    }
    paintPayloadSketch(
      canvas,
      hass,
      parsed,
      tagW,
      tagH,
      bg,
      rot,
      '#cc2200',
      mode === 'overlay',
      { cssW, cssH },
      selectedBounds,
      selectedHandles,
      activeHandleId
    );
  }

  function yamlEditShowSketch() {
    bumpYamlPreviewGenOnly();
    scheduleRedrawSketch();
  }

  function switchToHaPreview() {
    if (getPreviewMode() === 'split') return;
    const haInp = shadow.querySelector('input[name="od-pvm"][value="ha"]');
    if (haInp) /** @type {HTMLInputElement} */ (haInp).checked = true;
    syncPreviewFrameClass();
  }

  function bumpYamlPreviewGenOnly() {
    state.yamlPreviewBump += 1;
    state.pendingAutoHaBumpTarget = null;
    refreshHaStaleUi();
  }

  function leaveHaForEdit() {
    if (getPreviewMode() === 'overlay' || getPreviewMode() === 'sketch') {
      redrawSketch();
      return;
    }
    if (getPreviewMode() !== 'ha') return;
    const sel = previewImageHasSrc() ? 'overlay' : 'sketch';
    const inp = shadow.querySelector(`input[name="od-pvm"][value="${sel}"]`);
    if (inp) /** @type {HTMLInputElement} */ (inp).checked = true;
    syncPreviewFrameClass();
    redrawSketch();
  }

  function applyPreviewPicture(picPath, yamlBumpWhenRequestStarted) {
    if (!picPath) return;
    state.pendingAutoHaBumpTarget = state.yamlPreviewBump;
    const devId = effectiveDeviceId();
    if (devId) previewImgEl.dataset.odDeviceId = devId;
    previewImgEl.dataset.odRequestBump = String(
      yamlBumpWhenRequestStarted ?? state.yamlPreviewBump
    );
    const abs = /^https?:/i.test(picPath)
      ? picPath
      : `${window.location.origin}${picPath.startsWith('/') ? picPath : `/${picPath}`}`;
    const sep = abs.includes('?') ? '&' : '?';
    previewImgEl.src = `${abs}${sep}t=${Date.now()}`;
    previewImgEl.hidden = false;
    refreshPreviewPlaceholderVisibility();
  }

  function clearHaDryRunPreview() {
    state.pendingAutoHaBumpTarget = null;
    state.haBmpReflectsYamlBump = null;
    delete previewImgEl.dataset.odRequestBump;
    delete previewImgEl.dataset.odDeviceId;
    previewImgEl.removeAttribute('src');
    previewImgEl.hidden = true;
    refreshPreviewPlaceholderVisibility();
    refreshHaStaleUi();
  }

  async function invokeDrawcustom(dryRun, payloadArr, quiet) {
    const hass = getHass();
    const devId = effectiveDeviceId();
    if (!devId) throw new Error('No device');
    if (isVirtualDeviceSelected()) {
      throw new Error(
        'Virtual device has no Home Assistant target. Use a real OpenDisplay device for HA preview/send.'
      );
    }
    const imgBefore = imageEntityForDevice(hass, devId);
    const previewTicket =
      dryRun && imgBefore ? ++state.haDryApplyTicket : /** @type {-1 | number} */ (-1);
    const data = {
      ...readServiceData($, dryRun),
      payload: dryRun ? resolvePayloadForDryRun(hass, payloadArr) : payloadArr,
    };
    const picBefore =
      imgBefore && hass.states[imgBefore]?.attributes?.entity_picture;
    const yamlBumpWhenRequestStarted = state.yamlPreviewBump;
    await hass.callService('opendisplay', 'drawcustom', data, { device_id: devId });
    if (dryRun) {
      state.lastHaPreviewPayloadYaml = formatPayloadYamlList(
        resolvePayloadForDryRun(hass, payloadArr)
      );
    }
    if (dryRun && imgBefore && previewTicket >= 0) {
      // Render is done when callService resolves; reload immediately (cache-busted src).
      let picPath = entityPicturePath(getHass, imgBefore);
      if (previewTicket === state.haDryApplyTicket && picPath) {
        applyPreviewPicture(picPath, yamlBumpWhenRequestStarted);
      }
      const picAfter = await waitForPictureChange(getHass, imgBefore, picBefore);
      if (
        previewTicket === state.haDryApplyTicket &&
        picAfter &&
        picAfter !== picPath
      ) {
        applyPreviewPicture(picAfter, yamlBumpWhenRequestStarted);
      }
    }
    if (!quiet) {
      if (!dryRun) {
        showToast('Queued to OpenDisplay.', false);
      } else if (!imgBefore) {
        showToast('Dry-run OK (no image entity for preview)', false);
      } else {
        showToast('HA preview refreshed.', false);
      }
    }
  }

  async function quietAutoHaPreview() {
    if (isVirtualDeviceSelected()) return;
    if (!effectiveDeviceId()) return;
    const parsed = silentParsePayload();
    if (!parsed) return;
    state.haGeneration += 1;
    const myGen = state.haGeneration;
    try {
      await invokeDrawcustom(true, parsed, true);
    } catch {
      /* dry-run failures are surfaced only for manual Preview */
    }
    if (myGen === state.haGeneration) {
      $('#od-ha-status').textContent = `Last HA render ${new Date().toLocaleTimeString()}`;
    }
  }

  function scheduleDebouncedHaPreview() {
    if (state.haPreviewDebounceTimer) clearTimeout(state.haPreviewDebounceTimer);
    state.haPreviewDebounceTimer = setTimeout(() => {
      state.haPreviewDebounceTimer = null;
      void quietAutoHaPreview().catch(() => {});
    }, 180);
  }

  async function interactiveDrawcustom(dryRun) {
    if (!effectiveDeviceId()) {
      showToast('Select an OpenDisplay device.', true);
      return;
    }
    if (!deps.validatePayload() || !deps.lastValidPayload()) {
      showToast(deps.lastParseError() || 'Fix YAML', true);
      return;
    }
    const payloadArr = /** @type {unknown[]} */ (deps.lastValidPayload());
    try {
      await invokeDrawcustom(dryRun, payloadArr, false);
      $('#od-ha-status').textContent = `Last HA render ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      showToast(errMsg(e), true);
    }
  }

  function onPreviewImageLoad() {
    applyCombinedPreviewLayout();
    const raw = previewImgEl.dataset.odRequestBump;
    if (raw !== undefined && raw !== '') {
      const n = parseInt(String(raw).trim(), 10);
      state.haBmpReflectsYamlBump = Number.isFinite(n) ? n : null;
    } else {
      state.haBmpReflectsYamlBump = null;
    }
    refreshHaStaleUi();
    if (
      state.pendingAutoHaBumpTarget !== null &&
      state.pendingAutoHaBumpTarget === state.yamlPreviewBump
    ) {
      switchToHaPreview();
      state.pendingAutoHaBumpTarget = null;
    }
    if (getPreviewMode() !== 'ha') scheduleRedrawSketch();
  }

  return {
    getPreviewMode,
    syncPreviewFrameClass,
    refreshPreviewPlaceholderVisibility,
    refreshHaStaleUi,
    applyCombinedPreviewLayout,
    drawSketchMessage,
    scheduleRedrawSketch,
    redrawSketch,
    yamlEditShowSketch,
    bumpYamlPreviewGenOnly,
    leaveHaForEdit,
    applyPreviewPicture,
    clearHaDryRunPreview,
    scheduleDebouncedHaPreview,
    interactiveDrawcustom,
    onPreviewImageLoad,
  };
}
