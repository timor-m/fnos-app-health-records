import { cleanIndicatorName } from './indicator-name';

const measurementNumber = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+|\.\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const printedNumber = (value: string) => Number(value.replace(/,/g, ''));

/** Compare result semantics without treating a printed detection limit as a measured point. */
export function hasLostMeasurementBound(resultText: string, numericValue: number | null, quote: string) {
  const normalize = (value: string) => value.normalize('NFKC').replace(/≤/g, '<=').replace(/≥/g, '>=');
  const result = normalize(resultText).trim().replace(/^[↑↓▲▼⬆⬇]\s*/, '');
  const resultOperator = result.match(/^([<>]=?)/)?.[1];
  const value = numericValue ?? printedNumber(result);
  if (!Number.isFinite(value)) return false;
  const source = normalize(quote).split(/参考范围|参考区间|参考值|\breference\b/i)[0];
  return [...source.matchAll(new RegExp(`([<>]=?)\\s*(${measurementNumber})`, 'g'))].some(match =>
    printedNumber(match[2]) === value && resultOperator !== match[1]);
}

/** Only a scalar with an optional matching unit and abnormal flag is an exact point. */
export function parseExactMeasurement(resultText: string, unit: string | null, normalizeUnit?: (value: string) => string | null) {
  const text = resultText.normalize('NFKC').replace(/−/g, '-').trim().replace(/^[↑↓▲▼⬆⬇]\s*/, '');
  const match = text.match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+|\.\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)(.*)$/);
  if (!match) return null;
  const suffix = match[2].trim().replace(/^(?:[↑↓▲▼⬆⬇]|[HL](?=\s|$))\s*/i, '').replace(/(?:[↑↓▲▼⬆⬇*]|(?:^|\s)[HL])$/i, '').trim();
  const inlineUnit = suffix.replace(/^\((.*)\)$/, '$1');
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').replace(/[µμ]/g, 'u');
  const normalize = normalizeUnit || compact;
  if (suffix && (!unit || normalize(inlineUnit) !== normalize(unit))) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function hasLostMeasurementInterval(value: number, quote: string) {
  const source = quote.normalize('NFKC').split(/参考范围|参考区间|参考值|\breference\b/i)[0];
  return [...source.matchAll(new RegExp(`(${measurementNumber})\\s*(?:[-–—~～至]|\\.\\.)\\s*(${measurementNumber})`, 'g'))]
    .some(match => printedNumber(match[1]) === value || printedNumber(match[2]) === value);
}

/** The first printed number belongs to the selected result region, not a neighbouring item. */
export function leadingMeasurementNumber(value: string): number | null {
  const match = value.normalize('NFKC').replace(/[−–—]/g, '-').trim()
    .match(/^[↑↓▲▼⬆⬇]?\s*(?:<=|>=|[<>≤≥])?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+|\.\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** Locate name/value pairs in plain OCR; callers prefer verified table cells when available. */
export function measurementEvidenceRegions(quote: string, names: string[]): string[] {
  const cells = quote.normalize('NFKC').split(/[|｜;；\n]/).map(cell => cell.trim());
  const reference = /参考范围|参考区间|参考值|正常范围|\breference\b/i;
  const anchors = [...new Set(names.map(name => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()).filter(name => name.length >= 2 || /^\p{Script=Han}$/u.test(name)))]
    .sort((a, b) => b.length - a.length);
  const regions: string[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i].toLowerCase();
    if (/^(?:参考范围|参考区间|参考值|正常范围|reference)/i.test(cell)) continue;
    for (const name of anchors) {
      const pattern = [...name].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
      let matched = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}])`, 'iu').exec(cell);
      if (!matched) {
        // Only a leading table ordinal may be removed; preserve numeric medical qualifiers.
        const ordinal = new RegExp(`^\\d{1,3}\\s*${pattern}(?![\\p{L}])`, 'iu').exec(cell);
        if (ordinal && cleanIndicatorName(ordinal[0], {tableOrdinal: true}).name.replace(/\s+/g, '') === name) matched = ordinal;
      }
      if (!matched) continue;
      const remainder = cell.slice(matched.index + matched[0].length).replace(/^[):：\s]+/, '').split(reference)[0].trim();
      // A printed abbreviation in parentheses may follow the full project name.
      const inline = remainder.replace(/^\([a-z][a-z0-9+%#-]*\)/i, '');
      if (leadingMeasurementNumber(inline) !== null || /^(?:阴性|阳性|弱阳性|未检出|正常|异常)/.test(inline)) {
        regions.push(inline);
      } else if (!inline && cells[i + 1] && !reference.test(cells[i + 1])) {
        // The following cell may contain a unit; never include the reference column.
        const result = cells[i + 1].split(reference)[0];
        const next = cells[i + 2] || '';
        const unitCell = /^(?:[a-zμµ%‰/°℃][a-zμµ\d%‰/°℃·.^*×+-]*|[×x*]?10\s*\^?\s*\d+\s*\/\s*[a-zμµ]+)$/i.test(next.replace(/\s+/g, ''));
        regions.push([result, unitCell ? next : ''].filter(Boolean).join(' '));
      }
      break;
    }
  }
  return [...new Set(regions)];
}
