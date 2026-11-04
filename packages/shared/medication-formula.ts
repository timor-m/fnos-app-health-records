export type MedicationFormula = {
  kind: 'decoction';
  doseCount: string | null;
  preparation: string | null;
  ingredients: Array<{
    name: string;
    amount: string | null;
    unit: string | null;
    amountBasis: 'per_dose' | 'total' | 'unspecified';
    totalAmount: string | null;
    totalUnit: string | null;
    instructions: string | null;
    evidence: Array<{ pageNumber: number; quote: string }>;
  }>;
};

/** Shared by AI admission, manual correction, and persisted source snapshots. */
export function parseMedicationFormula(value: unknown): MedicationFormula | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'decoction' || !Array.isArray(row.ingredients) || !row.ingredients.length) return null;
  const text = (value: unknown, max = 300): string | null =>
    typeof value === 'string' ? value.trim().slice(0, max) || null
      : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const ingredients: MedicationFormula['ingredients'] = [];
  for (const value of row.ingredients) {
    if (!value || typeof value !== 'object') return null;
    const ingredient = value as Record<string, unknown>;
    const name = text(ingredient.name);
    const basis = ingredient.amountBasis ?? 'unspecified';
    if (!name || !['per_dose', 'total', 'unspecified'].includes(String(basis))) return null;
    ingredients.push({
      name, amount: text(ingredient.amount), unit: text(ingredient.unit, 60),
      amountBasis: basis as MedicationFormula['ingredients'][number]['amountBasis'],
      totalAmount: text(ingredient.totalAmount), totalUnit: text(ingredient.totalUnit, 60),
      instructions: text(ingredient.instructions, 1000),
      evidence: Array.isArray(ingredient.evidence) ? ingredient.evidence.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        const quote = text(item.quote, 1000);
        return Number.isInteger(item.pageNumber) && Number(item.pageNumber) > 0 && quote
          ? [{ pageNumber: Number(item.pageNumber), quote }] : [];
      }) : [],
    });
  }
  return { kind: 'decoction', doseCount: text(row.doseCount, 100), preparation: text(row.preparation, 1000), ingredients };
}
