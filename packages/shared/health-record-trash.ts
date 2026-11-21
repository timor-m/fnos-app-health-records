export type HealthTrashEntry = {
  id: string;
  kind: 'report' | 'vaccination' | 'symptom' | 'medication' | 'intake' | 'measurement' | 'process';
  memberId: string;
  title: string;
  date: string | null;
  doseNumber: string | null;
  institution: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
  revision: number | null;
};
export type HealthTrashPage = { items: HealthTrashEntry[]; nextCursor: string | null; hasMore: boolean };

export type HealthTrashTarget = Pick<HealthTrashEntry,'kind'|'id'|'memberId'|'title'|'revision'> & {kind:Exclude<HealthTrashEntry['kind'],'process'>};
export const healthTrashLabels: Record<HealthTrashEntry['kind'],string> = {report:'报告资料',vaccination:'接种记录',symptom:'症状',medication:'用药记录',intake:'服药记录',measurement:'测量记录',process:'健康历程'};
