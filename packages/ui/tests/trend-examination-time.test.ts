import {describe,it,expect} from 'vitest';
import {trendMeasurementTime,trendTimeSource} from '../src/utils/trends';
describe('examination trend time',()=>{
 it('preserves date, minute and second precision without adding midnight or converting timezones',()=>{
  expect(trendMeasurementTime({examinationId:'e',reportIssuedAt:'2026-09-08',timePrecision:'date'})).toBe('2026-09-08');
  expect(trendMeasurementTime({examinationId:'e',reportIssuedAt:'2026-09-08T08:30',timePrecision:'minute'})).toBe('2026-09-08 08:30');
  expect(trendMeasurementTime({examinationId:'e',reportIssuedAt:'2026-09-08 08:30:12',timePrecision:'second'})).toBe('2026-09-08 08:30:12');
  expect(trendMeasurementTime({reportIssuedAt:null})).toBe('日期待确认');
 });
 it('explicitly distinguishes legacy report time and examination time sources',()=>{
  expect(trendTimeSource({})).toBe('沿用报告时间');
  expect(trendTimeSource({examinationId:'e',timeKind:'sampled',timeStatus:'confirmed'})).toBe('采样时间 · 已核对');
  expect(trendTimeSource({examinationId:'e',timeKind:'issued',timeStatus:'automatic'})).toBe('签发时间');
 });
});
