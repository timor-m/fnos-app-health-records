import type { HealthProcessSummary,ProcessRecord } from './health-process';
export type HealthIndexKind='diagnosis'|'symptom';
export type HealthIndexEntry={key:string;name:string;count:number;lastAt:string|null};
export type HealthIndexRecord=ProcessRecord&{medications?:string[]};
export type HealthRecordIndexPage={memberId:string;kind:HealthIndexKind;name:string|null;entries:HealthIndexEntry[];records:HealthIndexRecord[];processes:HealthProcessSummary[];total:number;nextCursor:string|null};
