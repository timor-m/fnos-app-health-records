export const commonProcessSymptoms = ['发热','咳嗽','流鼻涕','鼻塞','腹泻','呕吐','皮疹'] as const;
import type { HealthSymptomChange } from './health-events';
export type ProcessQuickSymptom = {id:string;name:string;status:string;unit:string|null;latest?:{recordedAt:string;change:HealthSymptomChange|null;measurementValue:string|null;measurementUnit:string|null;temperatureValue?:string|null;severity:number|null}};
export type ProcessQuickMedication = {
  key:string;name:string;detail:string;origin:'course'|'prescription'|'intake';
  status:string|null;amount:string;unit:string;lastTakenAt?:string|null;
};
export type TemperatureReading = {value:number;at:string;symptomId:string;updateId:string};
export type ProcessTemperatureSummary = {
  highest:TemperatureReading;latest:TemperatureReading;count:number;recordedDays:number;
  threshold:number;thresholdDays:number;readings?:TemperatureReading[];
};
export type HealthProcessCare = {
  processId:string;memberId:string;fingerprint:string;summaryText:string;summaryReady?:boolean;summaryByDay?:string;doctorContext?:DoctorContext;
  symptoms:ProcessQuickSymptom[];medications:ProcessQuickMedication[];
  temperature:ProcessTemperatureSummary|null;
};
export type ProcessQuickRecordInput = {
  kind:'symptom'|'new_symptom'|'medication';target:string;fingerprint:string;recordedAt:string;
  change?:HealthSymptomChange|null;severity?:number|null;measurementValue?:string;measurementUnit?:string;temperatureValue?:string;
  description?:string;amount?:string;amountUnit?:string;requestKey:string;
};
export type ProcessQuickRecordResult = {processId:string;memberId:string;kind:'symptom'|'intake';id:string;symptomId?:string;fingerprint?:string;label?:string;recordedAt?:string};

export type DoctorContext = {memberId:string;processId:string;version:string;allergies:string;history:string;medications:string;concern:string};
