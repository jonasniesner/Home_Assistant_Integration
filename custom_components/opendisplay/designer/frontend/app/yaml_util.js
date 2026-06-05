import yaml from '../vendor/js-yaml.mjs';

/** Lines that are not part of a drawcustom payload list item. */
const PAYLOAD_GARBAGE_LINE =
  /^(?:\/?api\/|https?:\/\/|\}?\s*from\s+['"]|import\s+)/i;

/**
 * Normalize editor text: extract a pasted payload block and drop stray lines
 * (e.g. API URLs accidentally appended after the list).
 * @param {string} text
 */
export function normalizePayloadYamlInput(text) {
  let src = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!src) return '';

  if (/^\s*action\s*:/im.test(src)) {
    const m = src.match(/^\s*payload\s*:\s*\n([\s\S]*)$/im);
    if (m) {
      src = m[1].replace(/^\s{2}/gm, '').trim();
    }
  }

  const lines = src.split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) out.push(line);
      continue;
    }
    const isItem = /^\s*-\s/.test(line);
    const isField = /^\s+[\w-]+\s*:/.test(line);
    if (isItem) {
      inList = true;
      out.push(line);
    } else if (inList && isField) {
      out.push(line);
    } else if (inList) {
      if (PAYLOAD_GARBAGE_LINE.test(trimmed)) break;
      break;
    } else {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

/**
 * @param {unknown[]} payload
 */
export function dumpPayloadYaml(payload) {
  return yaml.dump(payload, { lineWidth: -1, indent: 2, noRefs: true });
}

/** @param {unknown} value */
export function formatYamlScalar(value) {
  if (typeof value === 'string') {
    if (
      value === '' ||
      /\r|\n/.test(value) ||
      /^\s|\s$/.test(value) ||
      /\{\{/.test(value) ||
      /\bstates\s*\(/.test(value) ||
      /\bstate_attr\s*\(/.test(value) ||
      /\bis_state\s*\(/.test(value) ||
      /[:#'"[\]{}]|^- /.test(value) ||
      /^(?:true|false|null|yes|no|on|off|~\s*|\*[\w-]+)$/i.test(value) ||
      /^[-+]?\d+(?:\.\d+)?$/i.test(value)
    ) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value);
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  return String(value);
}

/**
 * @param {unknown[]} payloadItems
 * @param {{ indent?: string }} [opts]
 */
function formatPayloadYamlLines(payloadItems, opts = {}) {
  const indent = opts.indent ?? '';
  const fieldIndent = `${indent}  `;
  const lines = [];
  if (!Array.isArray(payloadItems) || payloadItems.length === 0) {
    return [`${indent}[]`];
  }
  for (let i = 0; i < payloadItems.length; i += 1) {
    const item = payloadItems[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`payload[${i}] must be an object`);
    }
    const o = /** @type {Record<string, unknown>} */ (item);
    const t = o.type;
    if (typeof t !== 'string' || !t) {
      throw new Error(`payload[${i}] missing type`);
    }
    lines.push(`${indent}- type: ${formatYamlScalar(t)}`);
    for (const [key, val] of Object.entries(o)) {
      if (key === 'type') continue;
      lines.push(`${fieldIndent}${key}: ${formatYamlScalar(val)}`);
    }
  }
  return lines;
}

/**
 * Editor payload list (blueprint-style quoting for template values).
 * @param {unknown[]} payloadItems
 */
export function formatPayloadYamlList(payloadItems) {
  return formatPayloadYamlLines(payloadItems).join('\n');
}

/**
 * @param {unknown[]} payloadItems
 */
export function formatPayloadYamlBlock(payloadItems) {
  const lines = ['payload:'];
  if (!Array.isArray(payloadItems) || payloadItems.length === 0) {
    lines.push('  []');
    return lines.join('\n');
  }
  lines.push(...formatPayloadYamlLines(payloadItems, { indent: '  ' }));
  return lines.join('\n');
}

/**
 * Full automation snippet (copy-paste into YAML automations/scripts).
 */
export function buildServiceCallSnippet(deviceId, dataFields, payloadYamlBlock) {
  const { background, rotate, dither, refresh_type, dry_run } = dataFields;
  const lines = [
    'action: opendisplay.drawcustom',
    'target:',
    `  device_id: ${JSON.stringify(deviceId)}`,
    'data:',
    `  background: ${formatYamlScalar(background)}`,
    `  rotate: ${rotate}`,
    `  dither: ${formatYamlScalar(dither)}`,
    `  refresh_type: ${formatYamlScalar(refresh_type)}`,
    `  dry-run: ${dry_run ? 'true' : 'false'}`,
  ];
  const payloadLines = payloadYamlBlock.split('\n').map((l) => `  ${l}`);
  lines.push(...payloadLines);
  return lines.join('\n');
}
