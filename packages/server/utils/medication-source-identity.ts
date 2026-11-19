import { parseMedicationFormula } from '../../shared/medication-formula';
import { createHash } from 'node:crypto';

const fields = {
  context: 'medication_context', medicationName: 'medication_name', sectionName: 'section_name',
  specification: 'specification', dosageForm: 'dosage_form', dose: 'dose', doseUnit: 'dose_unit',
  frequency: 'frequency', route: 'route', duration: 'duration', quantity: 'quantity',
  quantityUnit: 'quantity_unit', instructions: 'instructions',
};
const prefix = 'source-medication-v1:';

/** Include the regimen so a correction to one prescription never hides its siblings. */
export function medicationSourceIdentity(row: Record<string, unknown>) {
  const parts = Object.entries(fields).map(([key, column]) => String(row[key] ?? row[column] ?? '')
    .normalize('NFKC').toLowerCase().replace(/\s+/g, ''));
  const formula = row.formula ?? (typeof row.formula_json === 'string' ? JSON.parse(row.formula_json) : null);
  const parsed = parseMedicationFormula(formula);
  if (parsed) parts.push(JSON.stringify({ ...parsed, ingredients: parsed.ingredients.map(({ evidence, ...ingredient }) => ingredient) }));
  return prefix + createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function originalMedicationIdentity(manualFieldsJson: string): string | undefined {
  try {
    const fields: unknown = JSON.parse(manualFieldsJson);
    return Array.isArray(fields) ? fields.find(value => typeof value === 'string' && value.startsWith(prefix)) : undefined;
  } catch { return undefined; }
}
