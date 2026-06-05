/**
 * Line-number gutter + diagnostic markers for the YAML editor.
 */

/**
 * @param {string} text
 * @param {number} itemIndex
 * @returns {{ line: number; offset: number } | null}
 */
export function findPayloadItemLineStart(text, itemIndex) {
  const lines = String(text || '').split('\n');
  let item = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s+type\s*:/.test(lines[i])) {
      item += 1;
      if (item === itemIndex) {
        let offset = 0;
        for (let j = 0; j < i; j += 1) offset += lines[j].length + 1;
        return { line: i, offset };
      }
    }
  }
  return null;
}

/**
 * @param {string} text
 * @param {Array<{ level: string; message: string }>} diags
 * @param {string | null} parseError
 */
export function collectGutterMarks(text, diags, parseError) {
  const lines = String(text || '').split('\n');
  /** @type {Set<number>} */
  const err = new Set();
  /** @type {Set<number>} */
  const warn = new Set();

  if (parseError) {
    const m = parseError.match(/line\s+(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) err.add(n - 1);
    } else {
      err.add(0);
    }
  }

  for (const d of diags || []) {
    const m = String(d.message || '').match(/Item\s+(\d+)/i);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (!Number.isFinite(idx) || idx < 0) continue;
    const pos = findPayloadItemLineStart(text, idx);
    if (!pos) continue;
    if (d.level === 'warn') warn.add(pos.line);
    else err.add(pos.line);
  }

  return { lineCount: Math.max(1, lines.length), err, warn };
}

/**
 * @param {HTMLTextAreaElement} ta
 * @param {HTMLElement} gutter
 * @param {string} text
 * @param {Array<{ level: string; message: string }>} diags
 * @param {string | null} parseError
 */
export function syncYamlGutter(ta, gutter, text, diags, parseError) {
  const { lineCount, err, warn } = collectGutterMarks(text, diags, parseError);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lineCount; i += 1) {
    const row = document.createElement('div');
    row.className = 'od-gutter-line';
    row.textContent = String(i + 1);
    if (err.has(i)) row.classList.add('od-gutter-err');
    else if (warn.has(i)) row.classList.add('od-gutter-warn');
    frag.appendChild(row);
  }
  gutter.replaceChildren(frag);
  gutter.scrollTop = ta.scrollTop;
}

/**
 * @param {HTMLElement} shell
 * @param {HTMLTextAreaElement} ta
 * @param {() => { text: string; diags: Array<{ level: string; message: string }>; parseError: string | null }} getState
 */
export function setupYamlGutter(shell, ta, getState) {
  const gutter = shell.querySelector('.od-editor-gutter');
  if (!gutter) return { refresh: () => {}, scrollToItem: () => {} };

  const refresh = () => {
    const { text, diags, parseError } = getState();
    syncYamlGutter(ta, /** @type {HTMLElement} */ (gutter), text, diags, parseError);
  };

  ta.addEventListener('scroll', () => {
    gutter.scrollTop = ta.scrollTop;
  });

  return {
    refresh,
    /** @param {number} itemIndex */
    scrollToItem(itemIndex) {
      const { text } = getState();
      const pos = findPayloadItemLineStart(text, itemIndex);
      if (!pos) return;
      ta.focus();
      ta.setSelectionRange(pos.offset, pos.offset);
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
      ta.scrollTop = Math.max(0, pos.line * lh - ta.clientHeight / 3);
      gutter.scrollTop = ta.scrollTop;
      refresh();
    },
  };
}
