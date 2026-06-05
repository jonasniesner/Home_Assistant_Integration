import {
  formatPayloadYamlBlock,
  formatPayloadYamlList,
  buildServiceCallSnippet,
} from './yaml_util.js';
import { buildBlueprintSnippet } from './designer_extras.js';
import { VIRTUAL_DEVICE_ID } from './dimensions.js';

/**
 * @param {(sel: string) => HTMLElement} $
 */
export function readServiceData($, dryRun) {
  return {
    background: /** @type {HTMLSelectElement} */ ($('#od-bg')).value,
    rotate: Number(/** @type {HTMLSelectElement} */ ($('#od-rot')).value),
    dither: /** @type {HTMLSelectElement} */ ($('#od-dither')).value,
    refresh_type: /** @type {HTMLSelectElement} */ ($('#od-refresh')).value,
    'dry-run': dryRun,
  };
}

/** @param {(sel: string) => HTMLElement} $ */
export function readExportFields($) {
  return {
    background: /** @type {HTMLSelectElement} */ ($('#od-bg')).value,
    rotate: Number(/** @type {HTMLSelectElement} */ ($('#od-rot')).value),
    dither: /** @type {HTMLSelectElement} */ ($('#od-dither')).value,
    refresh_type: /** @type {HTMLSelectElement} */ ($('#od-refresh')).value,
    dry_run: false,
  };
}

/**
 * @param {{
 *  $: (sel: string) => HTMLElement;
 *  effectiveDeviceId: () => string;
 *  silentParsePayload: () => unknown[] | null;
 * }} deps
 */
export function rebuildExportSnippet(deps) {
  const { $, effectiveDeviceId, silentParsePayload } = deps;
  const devId = effectiveDeviceId();
  const parsed = silentParsePayload();
  const payloadBlock = formatPayloadYamlBlock(Array.isArray(parsed) ? parsed : []);
  const exportEl = /** @type {HTMLPreElement} */ ($('#od-export'));
  if (devId === VIRTUAL_DEVICE_ID) {
    exportEl.textContent =
      'Virtual device selected: export/send is disabled (no Home Assistant target device_id).';
    return;
  }
  exportEl.textContent = devId
    ? buildServiceCallSnippet(devId, readExportFields($), payloadBlock)
    : 'Pick a device id to export.';
}

/**
 * @param {{
 *  $: (sel: string) => HTMLElement;
 *  effectiveDeviceId: () => string;
 *  silentParsePayload: () => unknown[] | null;
 *  showToast: (msg: string, isErr: boolean) => void;
 * }} deps
 */
export function copyExportSnippet(deps) {
  rebuildExportSnippet(deps);
  const text = /** @type {HTMLPreElement} */ (deps.$('#od-export')).textContent || '';
  navigator.clipboard.writeText(text).then(
    () => deps.showToast('Copied', false),
    () => deps.showToast('Copy failed', true)
  );
}

/**
 * @param {{
 *  silentParsePayload: () => unknown[] | null;
 *  showToast: (msg: string, isErr: boolean) => void;
 * }} deps
 */
export function copyBlueprintSnippet(deps) {
  const parsed = deps.silentParsePayload();
  if (!parsed) {
    deps.showToast('Fix YAML first', true);
    return;
  }
  const payloadIndented = formatPayloadYamlList(parsed)
    .split('\n')
    .map((l) => `          ${l}`)
    .join('\n');
  const text = buildBlueprintSnippet(payloadIndented);
  navigator.clipboard.writeText(text).then(
    () => deps.showToast('Blueprint copied', false),
    () => deps.showToast('Copy failed', true)
  );
}
