import { createError } from 'h3';
import { symptomMeasurementDefinitions, measurementsForSymptom, validSymptomMeasurementValue } from '../../shared/symptom-measurements';
import { assertOccurredDate, dateInput, textInput } from './health-event-input';

/** Validate against the same registry used by entry UI. Measurements are stored
 * through the existing symptom-update service, in the symptom create transaction. */
export function initialSymptomMeasurements(name: string, input: unknown) {
  if (input === undefined) return [];
  const primaryDefinitions=measurementsForSymptom(name);
  // Explicitly measured temperature may accompany any symptom; it does not change its name or imply fever.
  const definitions=[...new Map([...primaryDefinitions,...symptomMeasurementDefinitions.filter(item=>item.id==='temperature')].map(item=>[item.id,item])).values()];
  if (!Array.isArray(input) || input.length > definitions.length)
    throw createError({statusCode:400,statusMessage:'症状测量项无效'});
  const seen = new Set<string>();
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw createError({statusCode:400,statusMessage:'症状测量项无效'});
    const definition = definitions.find(definition => definition.id === item.kind);
    if (!definition || seen.has(definition.id))
      throw createError({statusCode:400,statusMessage:'测量项与症状不匹配或重复'});
    seen.add(definition.id);
    const value = textInput(item.value, definition.label, 100, true)!;
    if (!validSymptomMeasurementValue(definition, value))
      throw createError({statusCode:400,statusMessage:`请填写有效的${definition.label}数值`});
    const recordedAt = dateInput(item.recordedAt, '测量时间');
    if (!recordedAt || recordedAt.length === 10)
      throw createError({statusCode:400,statusMessage:'请选择完整的测量时间'});
    assertOccurredDate(recordedAt, '测量时间');
    const normalized=value.normalize('NFKC').trim();
    return definition.id==='temperature'&&!primaryDefinitions.some(item=>item.id===definition.id)
      ? {temperatureValue:normalized,recordedAt}
      : {measurementValue:normalized,measurementUnit:definition.unit,recordedAt};
  });
}
