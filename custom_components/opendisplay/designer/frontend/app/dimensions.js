/** Device list, tag dimensions, and display colors from image.* entity attributes. */

export const VIRTUAL_DEVICE_ID = '__virtual__';
export const DEFAULT_TAG_SIZE = { tagW: 296, tagH: 128 };
export const COLOR_FALLBACK = /** @type {const} */ (['white', 'black']);

const OPENDISPLAY_DOMAINS = /** @type {const} */ (['opendisplay']);
const COLOR_SYNONYMS = {
  b: 'black',
  w: 'white',
  r: 'red',
  y: 'yellow',
  a: 'accent',
  ha: 'accent',
};

/** @param {unknown} val */
export function parsePositiveInt(val) {
  const n = parseInt(String(val ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @param {string} c */
export function normalizeColorName(c) {
  const s = String(c || '').trim().toLowerCase();
  if (!s) return '';
  if (COLOR_SYNONYMS[s]) return COLOR_SYNONYMS[s];
  return s;
}

/** @param {string[]} colors */
export function uniqueColors(colors) {
  const out = [];
  const seen = new Set();
  for (const cRaw of colors) {
    const c = normalizeColorName(cRaw);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * @param {any} hass
 * @returns {Array<{ id: string; name: string }>}
 */
export function listOpenDisplayDevices(hass) {
  const devices = hass?.devices;
  if (!devices || typeof devices !== 'object') return [];
  /** @type {Array<{ id: string; name: string }>} */
  const out = [];
  for (const [id, d] of Object.entries(devices)) {
    if (!d || typeof d !== 'object') continue;
    const ids = /** @type {{ identifiers?: unknown }} */ (d).identifiers;
    let hit =
      Array.isArray(ids) &&
      ids.some(
        /** @returns {boolean} */ (tuple) =>
          Array.isArray(tuple) && OPENDISPLAY_DOMAINS.includes(tuple[0])
      );
    if (!hit && hass?.entities) {
      hit = Object.values(hass.entities).some(
        (e) => e && e.device_id === id && e.platform === 'opendisplay'
      );
    }
    if (!hit) continue;
    const dn = /** @type {any} */ (d);
    const name = String(dn.name_by_user || dn.name || dn.original_name || id).trim();
    out.push({ id, name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  out.push({ id: VIRTUAL_DEVICE_ID, name: 'Virtual device (local sketch)' });
  return out;
}

/**
 * @param {any} hass
 * @param {string} deviceId
 */
function entitiesForDevice(hass, deviceId) {
  const reg = hass?.entities;
  if (!reg || typeof reg !== 'object') return [];
  return Object.entries(reg).filter(
    ([, e]) => e && typeof e === 'object' && e.device_id === deviceId
  );
}

/** @param {any} ent @param {string} key */
function entityIdFromEntry(key, ent) {
  return String(ent?.entity_id || key);
}

/**
 * @param {any} hass
 * @param {string} deviceId
 * @returns {string | null}
 */
export function imageEntityForDevice(hass, deviceId) {
  /** @type {string[]} */
  const imgs = [];
  for (const [key, ent] of entitiesForDevice(hass, deviceId)) {
    const eid = entityIdFromEntry(key, ent);
    if (eid.startsWith('image.')) imgs.push(eid);
  }
  if (imgs.length === 0) return null;
  return (
    imgs.find((eid) => parsePositiveInt(hass.states[eid]?.attributes?.pixel_width) > 0) ??
    imgs[0]
  );
}

/**
 * @param {any} hass
 * @param {string} deviceId
 */
export function imageDisplayAttributes(hass, deviceId) {
  const eid = imageEntityForDevice(hass, deviceId);
  if (!eid) return null;
  const attrs = hass?.states?.[eid]?.attributes;
  if (!attrs || typeof attrs !== 'object') return null;
  return attrs;
}

/**
 * @param {any} hass
 * @param {string} eid
 * @returns {{ tagW: number; tagH: number } | null}
 */
function dimsFromEntityState(hass, eid) {
  const st = hass?.states?.[eid];
  if (!st) return null;
  const attrs = st.attributes && typeof st.attributes === 'object' ? st.attributes : {};
  const pw = parsePositiveInt(attrs.pixel_width);
  const ph = parsePositiveInt(attrs.pixel_height);
  if (pw && ph) return { tagW: pw, tagH: ph };
  const m = String(st.state ?? '').match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (!m) return null;
  const tagW = Number(m[1]);
  const tagH = Number(m[2]);
  if (!(tagW > 0 && tagH > 0)) return null;
  return { tagW, tagH };
}

/**
 * @param {any} hass
 * @param {string} deviceId
 */
export function dimensionsFromImageEntity(hass, deviceId) {
  const eid = imageEntityForDevice(hass, deviceId);
  if (!eid) return null;
  return dimsFromEntityState(hass, eid);
}

/**
 * @param {HTMLImageElement | null | undefined} imgEl
 */
export function dimensionsFromPreviewImage(imgEl) {
  if (!imgEl || imgEl.hidden) return null;
  if (!imgEl.complete) return null;
  const nw = imgEl.naturalWidth;
  const nh = imgEl.naturalHeight;
  if (!(nw > 8 && nh > 8)) return null;
  return { tagW: nw, tagH: nh };
}

/**
 * @param {any} hass
 * @param {string | null | undefined} deviceId
 * @param {HTMLImageElement | null | undefined} previewImgEl
 * @param {{ w: number; h: number }} virtualDims
 */
export function resolveTagPx(hass, deviceId, previewImgEl, virtualDims) {
  const fallback = { ...DEFAULT_TAG_SIZE };
  if (!deviceId) return { ...fallback, source: 'fallback_no_device' };
  if (deviceId === VIRTUAL_DEVICE_ID) {
    return {
      tagW: virtualDims.w || fallback.tagW,
      tagH: virtualDims.h || fallback.tagH,
      source: 'virtual_inputs',
    };
  }
  const fromImage = dimensionsFromImageEntity(hass, deviceId);
  if (fromImage) return { ...fromImage, source: 'image_entity' };
  const fromPreview = dimensionsFromPreviewImage(previewImgEl);
  if (fromPreview) return { ...fromPreview, source: 'preview_image' };
  return { ...fallback, source: 'fallback_default' };
}

/**
 * @param {Record<string, unknown> | null | undefined} attrs
 */
function colorsFromImageAttributes(attrs) {
  if (!attrs) return null;
  if (Array.isArray(attrs.available_colors) && attrs.available_colors.length) {
    return uniqueColors(attrs.available_colors.map((c) => String(c)));
  }
  return null;
}

/**
 * @param {any} hass
 * @param {string | null | undefined} deviceId
 */
export function availableDisplayColors(hass, deviceId) {
  if (!deviceId || deviceId === VIRTUAL_DEVICE_ID) return [...COLOR_FALLBACK];
  const fromImage = colorsFromImageAttributes(imageDisplayAttributes(hass, deviceId));
  return fromImage?.length ? fromImage : [...COLOR_FALLBACK];
}

/**
 * @param {any} hass
 * @param {string} deviceId
 */
export function colorMapForDevice(hass, deviceId) {
  const attrs = imageDisplayAttributes(hass, deviceId);
  const map = attrs?.color_map;
  if (map && typeof map === 'object') return { ...map };
  return null;
}

/**
 * @param {string} name
 * @param {any} hass
 * @param {string | null | undefined} deviceId
 */
export function colorChipHex(name, hass, deviceId) {
  const n = normalizeColorName(name);
  const map =
    deviceId && deviceId !== VIRTUAL_DEVICE_ID ? colorMapForDevice(hass, deviceId) : null;
  if (map) {
    const fromMap = map[name] ?? map[n];
    if (fromMap) return fromMap;
  }
  if (n === 'black') return '#000000';
  if (n === 'white') return '#ffffff';
  if (n === 'red') return '#cc0000';
  if (n === 'yellow') return '#d8b400';
  if (n === 'accent') return '#2a6cff';
  if (n === 'blue') return '#0022cc';
  if (n === 'green') return '#008800';
  if (n === 'gray' || n === 'grey' || n === 'half_black') return '#888';
  if (n.startsWith('#')) return n;
  return '#666';
}
