/**
 * Lightweight entity_id completion for a textarea (domain.entity style + states('...') context).
 */

const ENTITY_PARTIAL = '[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_.]*)?';

/**
 * True when the cursor sits in a plain YAML `key: value` line (not a template).
 * @param {string} text
 * @param {number} caret
 */
function isYamlPlainValueContext(text, caret) {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  if (
    line.includes('{{') ||
    /\bstates\s*\(/.test(line) ||
    /\bstate_attr\s*\(/.test(line) ||
    /\bis_state\s*\(/.test(line)
  ) {
    return false;
  }
  return /^\s*[\w-]+\s*:\s*\S*$/.test(line);
}

/**
 * @returns {{ start: number; partial: string; quote: string | null } | null}
 */
function getStatesTokenAtCursor(text, caret) {
  const before = text.slice(0, caret);
  const empty = before.match(/\bstates\s*\(\s*(['"])\s*$/);
  if (empty) {
    return { start: caret, partial: '', quote: empty[1] };
  }
  const statesMatch = before.match(
    new RegExp(`\\bstates\\s*\\(\\s*(['"])(${ENTITY_PARTIAL})$`)
  );
  if (!statesMatch) return null;
  const partial = statesMatch[2];
  const quote = statesMatch[1];
  const idx = before.lastIndexOf(statesMatch[0]);
  const start = idx + statesMatch[0].length - partial.length;
  return { start, partial, quote };
}

/**
 * @returns {{ start: number; partial: string; quote: string | null } | null}
 */
function getIsStateTokenAtCursor(text, caret) {
  const before = text.slice(0, caret);
  const empty = before.match(/\bis_state\s*\(\s*(['"])\s*$/);
  if (empty) {
    return { start: caret, partial: '', quote: empty[1] };
  }
  const m = before.match(
    new RegExp(`\\bis_state\\s*\\(\\s*(['"])(${ENTITY_PARTIAL})$`)
  );
  if (!m) return null;
  const partial = m[2];
  const quote = m[1];
  const idx = before.lastIndexOf(m[0]);
  const start = idx + m[0].length - partial.length;
  return { start, partial, quote };
}

/**
 * Cursor inside a plot/YAML `entity` value (plain id — not a Jinja template).
 * @returns {{ start: number; partial: string; quote: null; entityKeyContext: true } | null}
 */
function getEntityKeyValueToken(text, caret) {
  if (caret < 0 || caret > text.length) return null;
  const local = text.slice(Math.max(0, caret - 160), caret);
  if (local.includes('{{') || local.includes('{%')) return null;

  let end = caret;
  if (end > 0 && text[end - 1] === '"') end -= 1;

  let i = end - 1;
  while (i >= 0 && /[a-zA-Z0-9_.]/.test(text[i])) i -= 1;
  const partial = text.slice(i + 1, end);
  const head = text.slice(0, i + 1);

  if (/(?:^|[\r\n])[ \t]*(?:-\s+)?entity\s*:\s*$/m.test(head)) {
    return {
      start: i + 1,
      partial,
      quote: null,
      entityKeyContext: true,
    };
  }

  if (/"entity"\s*:\s*"$/.test(head)) {
    return {
      start: i + 1,
      partial,
      quote: null,
      entityKeyContext: true,
    };
  }

  return null;
}

/**
 * @returns {{ start: number; partial: string; quote: string | null } | null}
 */
export function getEntityTokenAtCursor(text, caret) {
  if (getEntityKeyValueToken(text, caret)) {
    return null;
  }

  if (isYamlPlainValueContext(text, caret)) {
    return null;
  }
  const statesToken = getStatesTokenAtCursor(text, caret);
  if (statesToken) return statesToken;
  const isStateToken = getIsStateTokenAtCursor(text, caret);
  if (isStateToken) return isStateToken;
  let i = caret - 1;
  while (i >= 0 && /[a-z0-9_.]/i.test(text[i])) {
    i -= 1;
  }
  const start = i + 1;
  const partial = text.slice(start, caret);
  if (!partial || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_.]*)?$/i.test(partial)) {
    return null;
  }
  return /** @type {{ start: number; partial: string; quote: null }} */ ({
    start,
    partial,
    quote: null,
  });
}

/**
 * state_attr('entity_id', 'attribute') completion.
 * - If cursor is in first arg: suggest entity_ids
 * - If cursor is in second arg: suggest attribute keys for that entity
 *
 * @returns {{ start:number; partial:string; quote:string; mode:'entity'|'attr'; entityId?:string } | null}
 */
function getStateAttrTokenAtCursor(text, caret) {
  const before = text.slice(0, caret);

  // 2nd argument (attribute) in progress.
  // Example: state_attr('sensor.weather', 'hum
  const attrMatch = before.match(
    new RegExp(
      `\\bstate_attr\\s*\\(\\s*(['"])(${ENTITY_PARTIAL})\\1\\s*,\\s*(['"])([a-z0-9_ -]*)$`,
      'i'
    )
  );
  if (attrMatch) {
    const entityId = attrMatch[2];
    const quote = attrMatch[3];
    const partial = attrMatch[4] || '';
    const idx = before.lastIndexOf(attrMatch[0]);
    const start = idx + attrMatch[0].length - partial.length;
    return { start, partial, quote, mode: 'attr', entityId };
  }

  // 1st argument (entity_id) in progress.
  // Example: state_attr('sensor.wea
  const entMatch = before.match(
    new RegExp(`\\bstate_attr\\s*\\(\\s*(['"])(${ENTITY_PARTIAL})$`, 'i')
  );
  if (entMatch) {
    const quote = entMatch[1];
    const partial = entMatch[2] || '';
    const idx = before.lastIndexOf(entMatch[0]);
    const start = idx + entMatch[0].length - partial.length;
    return { start, partial, quote, mode: 'entity' };
  }

  return null;
}

/**
 * @returns {{ start:number; partial:string } | null}
 */
function getColorTokenAtCursor(text, caret) {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const m = line.match(
    /^\s*(?:color|fill|outline|background|legend_color|stroke_fill)\s*:\s*['"]?([a-z0-9_#-]*)$/i
  );
  if (!m) return null;
  const partial = m[1] || '';
  const start = lineStart + line.length - partial.length;
  return { start, partial };
}

const TEMPLATE_STARTERS = [
  { label: "states('entity')", insert: "states('')" },
  { label: "state_attr('entity', 'attr')", insert: "state_attr('', '')" },
  { label: "is_state('entity', 'on')", insert: "is_state('', 'on')" },
];

/**
 * @returns {{ start: number; partial: string; mode: 'template' } | null}
 */
function getTemplateStarterToken(text, caret) {
  const before = text.slice(0, caret);
  if (/\{\{\s*$/.test(before)) {
    return { start: caret, partial: '', mode: 'template' };
  }
  const m = before.match(/\{\{\s*([a-z_]*)$/i);
  if (!m) return null;
  const partial = m[1] || '';
  return { start: caret - partial.length, partial, mode: 'template' };
}

/**
 * Pixel position of caret at `idx` relative to the field's client box.
 * @param {HTMLInputElement | HTMLTextAreaElement} field
 * @param {number} idx
 * @returns {{ top: number; left: number; lineHeight: number }}
 */
function fieldCaretOffsets(field, idx) {
  const win = field.ownerDocument.defaultView;
  if (!win) return { top: 0, left: 0, lineHeight: 18 };

  const doc = field.ownerDocument;
  const cs = win.getComputedStyle(field);
  const isTextarea = field instanceof HTMLTextAreaElement;

  /** @type {HTMLElement} */
  const div = doc.createElement('div');
  const props = /** @type {const} */ ([
    ['box-sizing', cs.boxSizing],
    ['width', `${field.clientWidth}px`],
    ['white-space', isTextarea ? 'pre-wrap' : 'pre'],
    ['word-wrap', 'break-word'],
    ['overflow-wrap', 'break-word'],
    ['direction', cs.direction],
    ['text-align', cs.textAlign],
    ['text-transform', cs.textTransform],
    ['text-indent', cs.textIndent],
    ['padding-top', cs.paddingTop],
    ['padding-right', cs.paddingRight],
    ['padding-bottom', cs.paddingBottom],
    ['padding-left', cs.paddingLeft],
    ['border-top-width', cs.borderTopWidth],
    ['border-right-width', cs.borderRightWidth],
    ['border-bottom-width', cs.borderBottomWidth],
    ['border-left-width', cs.borderLeftWidth],
    ['font-family', cs.fontFamily],
    ['font-weight', cs.fontWeight],
    ['font-style', cs.fontStyle],
    ['letter-spacing', cs.letterSpacing],
    ['tab-size', cs.tabSize],
    ['word-spacing', cs.wordSpacing],
    ['line-height', cs.lineHeight],
    ['font-size', cs.fontSize],
    ['overflow', 'hidden'],
    ['visibility', 'hidden'],
    ['position', 'absolute'],
    ['top', '-5000px'],
    ['left', '0'],
  ]);
  for (let i = 0; i < props.length; i += 1) {
    const [k, v] = props[i];
    div.style.setProperty(k, String(v));
  }

  div.textContent = field.value.slice(0, idx);
  const span = doc.createElement('span');
  span.textContent = field.value.slice(idx) || '\u200b';
  div.appendChild(span);

  doc.body.appendChild(div);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  const lhRaw = cs.lineHeight;
  const lhPx =
    lhRaw.endsWith('px') ? parseFloat(lhRaw) : parseFloat(cs.fontSize) * 1.45;
  const lineHeight = Number.isFinite(lhPx) && lhPx > 0 ? lhPx : 18;
  doc.body.removeChild(div);

  return { top, left, lineHeight };
}

/**
 * @param {any} hass
 * @param {string} partial
 * @param {number} limit
 */
export function filterEntityIds(hass, partial, limit = 40) {
  const keys = hass?.states ? Object.keys(hass.states) : [];
  const pl = partial.toLowerCase();
  const scored = keys
    .filter((k) => k.toLowerCase().startsWith(pl) || k.toLowerCase().includes(pl))
    .sort((a, b) => {
      const al = a.toLowerCase().startsWith(pl);
      const bl = b.toLowerCase().startsWith(pl);
      if (al !== bl) return al ? -1 : 1;
      return a.localeCompare(b);
    });
  return scored.slice(0, limit);
}

/** @param {any} hass @param {string} entityId */
function formatEntityState(hass, entityId) {
  const st = hass?.states?.[entityId];
  if (!st || st.state == null) return '';
  const s = String(st.state);
  if (s === 'unknown' || s === 'unavailable') return '';
  const unit = st.attributes?.unit_of_measurement;
  return unit ? `${s} ${unit}` : s;
}

/**
 * @param {any} hass
 * @param {string} partial
 * @param {number} limit
 * @returns {Array<{ insert: string; label: string }>}
 */
function filterEntitySuggestions(hass, partial, limit = 40) {
  return filterEntityIds(hass, partial, limit).map((id) => ({
    insert: id,
    label: id,
    value: formatEntityState(hass, id),
  }));
}

/**
 * Replace placeholder / missing plot entities with the best available HA entity.
 * @param {any} hass
 * @param {unknown} data
 * @returns {unknown[] | null}
 */
export function resolvePlotDataEntities(hass, data) {
  if (!Array.isArray(data)) return null;
  let changed = false;
  const out = data.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const rec = /** @type {Record<string, unknown>} */ ({ ...row });
    const eid = String(rec.entity || '').trim();
    if (eid && hass?.states?.[eid]) return row;
    const partial = eid.replace(/\.$/, '') || 'sensor';
    const picks = filterEntityIds(hass, partial, 50);
    const resolved =
      picks.find((id) => id === 'sensor.temperature') ||
      picks.find((id) => id.startsWith('sensor.')) ||
      picks[0];
    if (!resolved || resolved === eid) return row;
    changed = true;
    return { ...rec, entity: resolved };
  });
  return changed ? out : null;
}

/** @param {unknown} value @param {number} [maxLen] */
function formatAttrPreview(value, maxLen = 48) {
  if (value == null) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  return s;
}

/**
 * @param {any} hass
 * @param {string} entityId
 * @param {string} partial
 * @param {number} limit
 * @returns {Array<{ insert: string; label: string }>}
 */
function filterAttributeSuggestions(hass, entityId, partial, limit = 60) {
  const attrs = hass?.states?.[entityId]?.attributes;
  if (!attrs || typeof attrs !== 'object') return [];
  const keys = Object.keys(attrs);
  const pl = String(partial || '').toLowerCase();
  const scored = keys
    .filter((k) => k.toLowerCase().startsWith(pl) || k.toLowerCase().includes(pl))
    .sort((a, b) => {
      const al = a.toLowerCase().startsWith(pl);
      const bl = b.toLowerCase().startsWith(pl);
      if (al !== bl) return al ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, limit);
  return scored.map((key) => ({
    insert: key,
    label: key,
    value: formatAttrPreview(attrs[key]),
  }));
}

/**
 * @param {string[]} colors
 * @param {string} partial
 */
function filterColors(colors, partial) {
  const pl = String(partial || '').toLowerCase();
  return colors
    .filter((c) => c.toLowerCase().startsWith(pl) || c.toLowerCase().includes(pl))
    .slice(0, 20);
}

/**
 * @param {HTMLInputElement | HTMLTextAreaElement} field
 * @param {number} start
 * @param {number} end
 * @param {string} insert
 */
export function replaceRange(field, start, end, insert) {
  const v = field.value;
  const safeStart = Math.max(0, Math.min(start, v.length));
  const safeEnd = Math.max(safeStart, Math.min(end, v.length));
  field.value = v.slice(0, safeStart) + insert + v.slice(safeEnd);
  const np = safeStart + insert.length;
  field.selectionStart = field.selectionEnd = np;
  field.focus();
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Resolve the exact [start, end) range to replace for an autocomplete token.
 * @param {string} text
 * @param {{ start: number; partial?: string; end?: number; caretAtRefresh?: number }} token
 */
function resolveReplaceRange(text, token) {
  const partial = String(token.partial || '');
  const caretHint =
    typeof token.caretAtRefresh === 'number'
      ? token.caretAtRefresh
      : typeof token.end === 'number'
        ? token.end
        : text.length;

  if (token.entityKeyContext) {
    const start = Number(token.start);
    if (partial.length > 0) {
      return { start, end: start + partial.length };
    }
    return { start, end: Math.max(start, caretHint) };
  }

  if (!partial.length) {
    const start = Math.max(0, Math.min(Number(token.start), text.length));
    const end = Math.max(start, Math.min(caretHint, text.length));
    return { start, end };
  }

  const storedStart = Number(token.start);
  if (
    storedStart >= 0 &&
    text.slice(storedStart, storedStart + partial.length).toLowerCase() === partial.toLowerCase()
  ) {
    return { start: storedStart, end: storedStart + partial.length };
  }

  const endFromCaret = Math.max(0, Math.min(caretHint, text.length));
  const startFromCaret = endFromCaret - partial.length;
  if (
    startFromCaret >= 0 &&
    text.slice(startFromCaret, endFromCaret).toLowerCase() === partial.toLowerCase()
  ) {
    return { start: startFromCaret, end: endFromCaret };
  }

  let end = endFromCaret;
  let start = storedStart >= 0 ? storedStart : end;
  while (start > 0 && /[a-z0-9_.]/i.test(text[start - 1])) start -= 1;
  while (end < text.length && /[a-z0-9_.]/i.test(text[end])) end += 1;
  return { start, end };
}

/**
 * @param {HTMLElement} wrap
 * @param {HTMLInputElement | HTMLTextAreaElement} field
 * @param {() => any} getHass
 * @param {{
 *  getColorSuggestions?: () => string[];
 *  wrapAsStates?: boolean;
 *  colorField?: boolean;
 * }} [opts]
 */
export function createFieldAutocomplete(wrap, field, getHass, opts = {}) {
  wrap.style.position = 'relative';
  const list = document.createElement('ul');
  list.className = 'od-autocomplete';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  wrap.appendChild(list);
  list.addEventListener('mousedown', (e) => e.preventDefault());

  let active = -1;
  let token = /** @type {Record<string, unknown> | null} */ (null);
  let suggestions = /** @type {Array<{ insert: string; label: string; value?: string }>} */ ([]);
  let picking = false;

  function hide() {
    list.hidden = true;
    list.replaceChildren();
    active = -1;
    token = null;
    suggestions = [];
  }

  function positionList() {
    const anchor = token
      ? Math.min(Number(token.start), field.value.length)
      : field.selectionStart ?? 0;

    let cTop = 0;
    let cLeft = 0;
    let lineHeight = 18;
    try {
      ({ top: cTop, left: cLeft, lineHeight } = fieldCaretOffsets(field, anchor));
    } catch {
      hide();
      return;
    }

    let x = field.offsetLeft + field.clientLeft + cLeft - field.scrollLeft;
    const lineTop = field.offsetTop + field.clientTop + cTop - field.scrollTop;
    let y = lineTop + lineHeight;

    const pad = 4;
    const maxWAvail = wrap.clientWidth - pad * 2;
    const preferredW = Math.min(460, Math.max(200, field.clientWidth));
    let listW = Math.min(preferredW, Math.max(160, wrap.clientWidth - x - pad));
    listW = Math.max(140, Math.min(listW, maxWAvail));

    if (x + listW + pad > wrap.clientWidth) {
      x = Math.max(pad, wrap.clientWidth - listW - pad);
    }
    x = Math.max(pad, x);

    const estH = Math.min(
      Math.max(list.scrollHeight || 0, suggestions.length * 34 + 20),
      280
    );
    if (y + estH + pad > wrap.clientHeight) {
      const aboveY = lineTop - estH - 6;
      if (aboveY >= pad) y = aboveY;
    }

    list.style.left = `${x}px`;
    list.style.top = `${Math.max(pad, y)}px`;
    list.style.width = `${listW}px`;
  }

  function renderList(items) {
    list.replaceChildren();
    items.forEach((item, idx) => {
      const li = document.createElement('li');
      const idSpan = document.createElement('span');
      idSpan.className = 'od-ac-id';
      idSpan.textContent = item.label;
      li.appendChild(idSpan);
      if (item.value) {
        const valSpan = document.createElement('span');
        valSpan.className = 'od-ac-val';
        valSpan.textContent = item.value;
        li.appendChild(valSpan);
      }
      li.dataset.idx = String(idx);
      li.setAttribute('role', 'option');
      if (idx === active) li.classList.add('active');
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(idx);
      });
      list.appendChild(li);
    });
    list.hidden = items.length === 0;
    positionList();
    requestAnimationFrame(() => {
      if (!list.hidden && suggestions.length > 0) positionList();
    });
  }

  function buildEntityInsert(id) {
    if (opts.wrapAsStates) return `{{ states('${id}') }}`;
    return id;
  }

  function pick(idx) {
    if (!token || idx < 0 || idx >= suggestions.length) return;
    const snap = { ...token };
    const choice = suggestions[idx].insert;
    field.focus({ preventScroll: true });
    const { start, end } = resolveReplaceRange(field.value, snap);
    picking = true;
    replaceRange(field, start, end, choice);
    picking = false;
    hide();
  }

  /** @param {Record<string, unknown>} t */
  function stampToken(t) {
    const caret = field.selectionStart ?? field.value.length;
    const partial = String(t.partial || '');
    const storedStart = Number(t.start);
    let end = caret;
    if (
      partial.length > 0 &&
      storedStart >= 0 &&
      field.value.slice(storedStart, storedStart + partial.length).toLowerCase() ===
        partial.toLowerCase()
    ) {
      end = storedStart + partial.length;
    }
    return { ...t, end, caretAtRefresh: caret };
  }

  function refresh() {
    const hass = getHass();
    const caret = field.selectionStart ?? field.value.length;
    const text = field.value;

    const tpl = getTemplateStarterToken(text, caret);
    if (tpl) {
      token = stampToken(tpl);
      const partial = String(tpl.partial || '').toLowerCase();
      suggestions = TEMPLATE_STARTERS.filter(
        (s) =>
          !partial ||
          s.label.toLowerCase().includes(partial) ||
          s.insert.toLowerCase().startsWith(partial)
      ).map((s) => ({
        insert: partial ? `${s.insert} }}` : ` ${s.insert} }}`,
        label: s.label,
        value: 'Jinja',
      }));
      if (suggestions.length === 0) {
        hide();
        return;
      }
      active = 0;
      renderList(suggestions);
      return;
    }

    if (opts.colorField && !text.includes('{{')) {
      const before = text.slice(0, caret);
      const m = before.match(/([a-z0-9_#-]*)$/i);
      if (m) {
        token = stampToken({ start: caret - m[1].length, partial: m[1], quote: null });
        const colors =
          typeof opts.getColorSuggestions === 'function'
            ? opts.getColorSuggestions()
            : ['white', 'black'];
        suggestions = filterColors(colors, m[1]).map((c) => ({
          insert: c,
          label: c,
          value: '',
        }));
        if (suggestions.length > 0) {
          active = 0;
          renderList(suggestions);
          return;
        }
      }
    }

    const colorToken = getColorTokenAtCursor(text, caret);
    if (colorToken) {
      token = stampToken({
        start: colorToken.start,
        partial: colorToken.partial,
        quote: null,
      });
      const colors =
        typeof opts.getColorSuggestions === 'function'
          ? opts.getColorSuggestions()
          : ['white', 'black'];
      suggestions = filterColors(colors, colorToken.partial).map((c) => ({
        insert: c,
        label: c,
        value: '',
      }));
      if (suggestions.length === 0) {
        hide();
        return;
      }
      active = 0;
      renderList(suggestions);
      return;
    }

    const entityKey = getEntityKeyValueToken(text, caret);
    if (entityKey) {
      token = stampToken(entityKey);
      suggestions = filterEntitySuggestions(hass, entityKey.partial).map((s) => ({
        ...s,
        insert: s.insert,
      }));
      if (suggestions.length === 0) {
        hide();
        return;
      }
      active = 0;
      renderList(suggestions);
      return;
    }

    const sa = getStateAttrTokenAtCursor(text, caret);
    if (sa) {
      token = stampToken(sa);
      if (sa.mode === 'attr' && sa.entityId) {
        suggestions = filterAttributeSuggestions(hass, sa.entityId, sa.partial);
      } else {
        suggestions = filterEntitySuggestions(hass, sa.partial).map((s) => ({
          ...s,
          insert: sa.quote != null ? s.insert : buildEntityInsert(s.insert),
        }));
      }
      if (suggestions.length === 0) {
        hide();
        return;
      }
      active = 0;
      renderList(suggestions);
      return;
    }

    const t = getEntityTokenAtCursor(text, caret);
    const allowEmpty = t && t.quote != null;
    if (!t || (t.partial.length < 1 && !allowEmpty)) {
      hide();
      return;
    }
    token = stampToken(/** @type {any} */ (t));
    suggestions = filterEntitySuggestions(hass, t.partial).map((s) => ({
      ...s,
      insert: t.quote != null ? s.insert : buildEntityInsert(s.insert),
    }));
    if (suggestions.length === 0) {
      hide();
      return;
    }
    active = 0;
    renderList(suggestions);
  }

  field.addEventListener('blur', () => {
    setTimeout(hide, 150);
  });
  field.addEventListener('scroll', () => {
    if (!list.hidden) positionList();
  });

  field.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
        e.preventDefault();
        refresh();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, suggestions.length - 1);
      renderList(suggestions);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      renderList(suggestions);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(active);
    }
  });

  field.addEventListener('input', () => {
    if (picking) return;
    refresh();
  });
  field.addEventListener('click', refresh);
  field.addEventListener('keyup', (e) => {
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'Home' ||
      e.key === 'End'
    ) {
      refresh();
    }
  });

  return { refresh, hide, maybeOpen: refresh };
}

/**
 * @param {HTMLElement} wrap
 * @param {HTMLTextAreaElement} ta
 * @param {() => any} getHass
 */
export function setupEntityAutocomplete(wrap, ta, getHass, opts = {}) {
  return createFieldAutocomplete(wrap, ta, getHass, opts);
}

/**
 * Attach autocomplete to all inspector text fields (re-created each selection).
 * @param {HTMLElement} panel
 * @param {() => any} getHass
 */
export function setupInspectorAutocomplete(panel, getHass, opts = {}) {
  const controllers = [];
  panel.querySelectorAll('.od-inspector-field-wrap').forEach((wrap) => {
    const field = wrap.querySelector('input, textarea');
    if (!field || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      return;
    }
    controllers.push(
      createFieldAutocomplete(
        /** @type {HTMLElement} */ (wrap),
        field,
        getHass,
        {
          getColorSuggestions: opts.getColorSuggestions,
          wrapAsStates: field.dataset.odAcEntity === '1',
          colorField: field.dataset.odAcColors === '1',
        }
      )
    );
  });
  return {
    refresh: () => controllers.forEach((c) => c.refresh()),
    hide: () => controllers.forEach((c) => c.hide()),
  };
}
