export type ExaminationTimeKind = 'sampled' | 'examined' | 'issued' | 'manual' | 'unknown';
export type ExaminationTimePrecision = 'date' | 'minute' | 'second' | 'unknown';
export type ExaminationEvidence = { pageId?: string; pageNumber: number; quote: string; lineIds?: string[] };
export type ExaminationInput = {
  examinationType?: string; institution?: string; reportNumber?: string; specimen?: string; method?: string;
  sampledAt?: string | null; examinedAt?: string | null; issuedAt?: string | null;
  timeText?: string; evidence?: ExaminationEvidence[];
};

/** No timezone, missing year, or invented midnight. Compare source-local civil times. */
export function parseExaminationTime(value: unknown): { value: string; precision: ExaminationTimePrecision } | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2199 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || (second !== undefined && Number(second) > 59))) return null;
  const pad = (part: string) => part.padStart(2, '0');
  return { value: `${year}-${pad(month)}-${pad(day)}${hour === undefined ? '' : ` ${pad(hour)}:${minute}${second === undefined ? '' : `:${second}`}`}`, precision: hour === undefined ? 'date' : second === undefined ? 'minute' : 'second' };
}

export function resolveExaminationTime(input: ExaminationInput) {
  const sampled = parseExaminationTime(input.sampledAt);
  const examined = parseExaminationTime(input.examinedAt);
  const issued = parseExaminationTime(input.issuedAt);
  const risks: string[] = [];
  for (const [name, raw, parsed] of [['sampled',input.sampledAt,sampled],['examined',input.examinedAt,examined],['issued',input.issuedAt,issued]] as const) {
    if (raw && !parsed) risks.push(`${name}_invalid_time`);
  }
  // Only compare known precision. Date-only and same-day timed facts are compatible.
  const after = (a: string, b: string) => a.slice(0, Math.min(a.length,b.length)) > b.slice(0,Math.min(a.length,b.length));
  if (issued && [sampled,examined].some(value => value && after(value.value,issued.value))) risks.push('event_after_issue');
  const lab = /检验|化验|血常规|尿常规|生化|lab|laboratory/i.test(input.examinationType || '');
  const order = lab ? [['sampled',sampled],['examined',examined],['issued',issued]] as const : [['examined',examined],['sampled',sampled],['issued',issued]] as const;
  const selected = order.find(([,value]) => value);
  return {
    sampledAt: sampled?.value || null, examinedAt: examined?.value || null, issuedAt: issued?.value || null,
    occurredAt: risks.length ? null : selected?.[1]?.value || null,
    timeKind: (risks.length ? 'unknown' : selected?.[0] || 'unknown') as ExaminationTimeKind,
    timePrecision: (risks.length ? 'unknown' : selected?.[1]?.precision || 'unknown') as ExaminationTimePrecision,
    risks
  };
}

export type ExaminationRecord = {
  id: string; reportId: string; examinationType: string; institution: string; reportNumber: string;
  specimen: string; method: string; sampledAt: string | null; examinedAt: string | null; issuedAt: string | null;
  occurredAt: string | null; timeKind: ExaminationTimeKind; timePrecision: ExaminationTimePrecision;
  timeText: string; evidence: ExaminationEvidence[]; confirmationStatus: 'pending' | 'automatic' | 'confirmed';
};
export type ExaminationObservation = {
  observationId: string; itemName: string; resultText: string; unit: string | null;
  examinationId: string | null; assignmentSource: 'automatic' | 'manual' | null;
  evidence: unknown;
};

export type ExaminationProposal = {
  key: string; examination: ExaminationInput; occurredAt: string | null; certain: boolean;
  observations: Array<{observationId: string; itemName: string; resultText: string; unit: string | null; previousTime: string | null}>;
};
export type ExaminationPreview = {
  version: number; reportVersion: number; hasOcr: boolean; protectedCount: number;
  proposals: ExaminationProposal[];
};
