import {afterEach,expect,it,vi} from 'vitest';
import {localSymptomDate,toggleAssociatedSymptom,symptomBodyAreaOptions} from '../src/utils/symptom-presets';
afterEach(()=>vi.useRealTimers());
it('uses local calendar days across year boundaries without forcing a time into onset dates',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(2026,0,1,0,30));
 expect(localSymptomDate()).toBe('2026-01-01');expect(localSymptomDate(1)).toBe('2025-12-31');
});
it('adds and removes a companion while preserving custom entries and recognizing existing separators',()=>{
 expect(toggleAssociatedSymptom('合成伴随，咳嗽;头痛','咳嗽')).toBe('合成伴随、头痛');
 expect(toggleAssociatedSymptom('合成伴随、头痛','乏力')).toBe('合成伴随、头痛、乏力');
});
it('limits detailed locations to the chosen region and does not invent a body area for non-location choices',()=>{
 expect(symptomBodyAreaOptions('abdomen').map(option=>option.value)).toContain('左下腹');
 expect(symptomBodyAreaOptions('eyes').map(option=>option.value)).toEqual(['眼部','左眼','右眼','双眼']);
 expect(symptomBodyAreaOptions('general')).toEqual([]);expect(symptomBodyAreaOptions('sleep')).toEqual([]);
});
