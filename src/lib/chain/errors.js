function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, (_key, nestedValue) => (
      typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
    ));
  } catch {
    return String(value);
  }
}

function addPart(parts, seen, value) {
  const text = asText(value).trim();
  if (!text || seen.has(text)) return;
  seen.add(text);
  parts.push(text);
}

function hexToAscii(hex) {
  const body = typeof hex === 'string' && hex.startsWith('0x') ? hex.slice(2) : '';
  if (!body || body.length % 2 !== 0) return '';

  const bytes = body.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16));
  if (bytes.some((byte) => byte < 0x20 || byte > 0x7e)) return '';
  return String.fromCharCode(...bytes);
}

function formatHexData(data) {
  const ascii = hexToAscii(data);
  return ascii ? `data=${data}; ascii=${ascii}` : `data=${data}`;
}

function collectErrorParts(error, parts, seen, depth = 0) {
  if (!error || depth > 8) return;

  if (typeof error !== 'object') {
    addPart(parts, seen, error);
    return;
  }

  addPart(parts, seen, error.message);
  addPart(parts, seen, error.details);

  const data = error.data;
  if (typeof data === 'string') {
    addPart(parts, seen, formatHexData(data));
  } else if (data && typeof data === 'object') {
    addPart(parts, seen, data.message);
    addPart(parts, seen, data.details);
    addPart(parts, seen, data.data ? formatHexData(data.data) : '');
  }

  collectErrorParts(error.cause, parts, seen, depth + 1);
}

export function formatChainError(error, fallback = 'Transaction failed.') {
  const parts = [];
  const seen = new Set();

  collectErrorParts(error, parts, seen);

  if (parts.length > 0) return parts.join('\n');
  return asText(error) || fallback;
}
