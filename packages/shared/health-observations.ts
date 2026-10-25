import type { HealthRecordRef } from './health-record-associations';
import type { HealthSymptomChange } from './health-events';
export type ObservationRef={kind:'symptom'|'intake';id:string};
export type ObservationCategory='symptom'|'temperature'|'intake';
export type HealthObservation={
 ref:ObservationRef;record:HealthRecordRef;memberId:string;name:string;recordedAt:string;revision:number;category:ObservationCategory;
 change:HealthSymptomChange|null;severity:number|null;measurementValue:string|null;measurementUnit:string|null;temperatureValue?:string|null;
 amount:string|null;amountUnit:string|null;description:string|null;
};
export type ObservationPage={processId:string;memberId:string;items:HealthObservation[];total:number;counts:Record<ObservationCategory,number>;nextCursor:string|null};
export type SymptomContinuationCandidate={id:string;memberId:string;name:string;bodyArea:string|null;startedAt:string|null;latestAt:string|null;status:string;unit:string|null};
export type SymptomContinuationPage={memberId:string;scope:'process'|'related'|'member';items:SymptomContinuationCandidate[];total:number;nextCursor?:string|null};
