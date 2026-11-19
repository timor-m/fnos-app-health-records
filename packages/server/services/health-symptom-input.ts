import { createError } from 'h3';
import { hasInput, localToday, textInput } from './health-event-input';

export function localSymptomMoment() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${localToday(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Date-only boundaries cover the entire calendar day. */
export function symptomDateBefore(left: string, right: string) {
  return left.length === 10 || right.length === 10
    ? left.slice(0,10) < right.slice(0,10) : Date.parse(left) < Date.parse(right);
}

export type SymptomDetails = {
  bodyArea: string | null; severity: number | null; frequency: string | null;
  description: string | null; triggerText: string | null;
  relievingText: string | null; associatedSymptomsText: string | null;
};

export function symptomSeverity(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10)
    throw createError({ statusCode: 400, statusMessage: '严重程度应为 0 到 10' });
  return Number(value);
}

export function symptomDetails(input: Record<string, unknown>, existing?: SymptomDetails): SymptomDetails {
  return {
    bodyArea: hasInput(input, 'bodyArea') ? textInput(input.bodyArea, '身体部位', 120) : existing?.bodyArea ?? null,
    severity: hasInput(input, 'severity') ? symptomSeverity(input.severity) : existing?.severity ?? null,
    frequency: hasInput(input, 'frequency') ? textInput(input.frequency, '频率', 120) : existing?.frequency ?? null,
    description: hasInput(input, 'description') ? textInput(input.description, '症状描述', 2000) : existing?.description ?? null,
    triggerText: hasInput(input, 'triggerText') ? textInput(input.triggerText, '诱因', 500) : existing?.triggerText ?? null,
    relievingText: hasInput(input, 'relievingText') ? textInput(input.relievingText, '缓解因素', 500) : existing?.relievingText ?? null,
    associatedSymptomsText: hasInput(input, 'associatedSymptomsText')
      ? textInput(input.associatedSymptomsText, '伴随症状', 500) : existing?.associatedSymptomsText ?? null,
  };
}
