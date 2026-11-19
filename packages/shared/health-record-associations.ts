import type { HealthFeedEntry } from './health-categories';
import type { HealthProcessSummary } from './health-process';
export type HealthRecordRef = { kind: HealthFeedEntry['kind']; id: string };
export type AssociationSubject = HealthRecordRef;
export type RecordProcess = HealthProcessSummary;
export type RecordAssociation = {
  memberId: string; subject: HealthRecordRef; title: string;
  processes: HealthProcessSummary[];
  records: Array<{entry:HealthFeedEntry;directlyLinked:boolean}>;
  evidence: Array<{ref:HealthRecordRef;title:string;label:string}>;
};
export type AssociationInput = {subject:HealthRecordRef;records:HealthRecordRef[];action:'attach'|'detach'};
