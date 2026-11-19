/** Optional, explicitly entered observations. A name match enables a field; it
 * never supplies a value, infers a diagnosis or changes symptom severity. */
export type SymptomMeasurementDefinition = {
  id: string;
  label: string;
  unit: string;
  valueType: 'positive-decimal';
  symptomNames: readonly string[];
};
export const symptomMeasurementDefinitions: readonly SymptomMeasurementDefinition[] = [
  { id: 'temperature', label: '体温', unit: '℃', valueType: 'positive-decimal', symptomNames: ['发热','发烧','体温','低热','高热'] },
];
export type InitialSymptomMeasurement = { kind: string; value: string; recordedAt: string };
export function measurementsForSymptom(name: string): SymptomMeasurementDefinition[] {
  const normalized = name.normalize('NFKC').trim();
  return symptomMeasurementDefinitions.filter(definition => definition.symptomNames.includes(normalized));
}
export function validSymptomMeasurementValue(definition: SymptomMeasurementDefinition, value: string): boolean {
  const normalized = value.normalize('NFKC').trim();
  return definition.valueType === 'positive-decimal' && /^\d+(?:\.\d+)?$/.test(normalized)
    && Number.isFinite(Number(normalized)) && Number(normalized) > 0;
}

export function isCelsiusUnit(unit: string | null | undefined): boolean {
 return ['℃','°c','c','摄氏度'].includes((unit||'').normalize('NFKC').replace(/\s/g,'').toLowerCase());
}
export function isTemperatureMeasurement(value: string | null | undefined, unit: string | null | undefined): boolean {
 const definition=symptomMeasurementDefinitions.find(item=>item.id==='temperature')!;
 return isCelsiusUnit(unit)&&validSymptomMeasurementValue(definition,value||'');
}
