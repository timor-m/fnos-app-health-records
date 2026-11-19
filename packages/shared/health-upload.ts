import type { HealthRecordRef } from './health-record-associations';
export type HealthUploadContext = {
  processId?:string;relatedRecord?:HealthRecordRef;reminderId?: string;
};
