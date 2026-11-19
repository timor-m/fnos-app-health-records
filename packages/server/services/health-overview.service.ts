import { listRecordProcesses } from './health-record-process.service';
import type { RequestUser } from '../domain/request-user';
import { healthCategories, reportCategory, type HealthFeedEntry } from '../../shared/health-categories';
import type { HealthOverview } from '../../shared/health-overview';
import { healthRecordSnapshot } from './health-record-feed.service';
import { listReminders } from './records.service';
import { getSavedDuplicateHint } from './report-duplicate-precheck.service';

/** Record counts follow the timeline; upload previews follow source document creation. */
export function getOverview(user: RequestUser, memberId: string): HealthOverview {
  const snapshot = healthRecordSnapshot(user, { memberId });
  const entries = snapshot.entries;
  const categoryCounts = Object.fromEntries(healthCategories.map(category => [category,
    entries.filter(entry => entry.category === category).length])) as HealthOverview['categoryCounts'];
  const reminders = listReminders(user, memberId).filter(item => item.status === 'pending');
  // Include each uploaded source once, even when grouped or used by confirmed records.
  const documents = [...snapshot.documents].sort((a,b) =>
    (Date.parse(b.uploadedAt||'')||0)-(Date.parse(a.uploadedAt||'')||0) || b.id.localeCompare(a.id));
  const pendingStatuses = ['failed', 'needs_review', 'processing', 'uploading', 'queued'];
  const pendingDocuments = documents.filter(doc => pendingStatuses.includes(doc.status));
  const hints=new Map<string,HealthFeedEntry['duplicateHint']>();
  for(const doc of [...documents.slice(0,5),...pendingDocuments.slice(0,2)])
    if(!hints.has(doc.id))hints.set(doc.id,getSavedDuplicateHint(doc.id,memberId));
  const documentEntry = (doc:typeof documents[number]):HealthFeedEntry => ({
    id:`document:${doc.id}`, resourceId:doc.id, memberId,
    kind:doc.reportType === 'prescription'?'medication_document':'report',
    category:reportCategory(doc.reportType), title:doc.title, date:doc.reportIssuedAt, uploadedAt:doc.uploadedAt,
    subtype:doc.reportType, status:doc.status, institution:doc.hospitalName,
    description:null, documents:[doc], duplicateHint:hints.get(doc.id),
    processIds:[...new Set(entries.filter(entry=>entry.documents.some(source=>source.id===doc.id)).flatMap(entry=>entry.processIds))]
  });
  const symptoms = entries.filter(entry => entry.kind === 'symptom' && entry.status === 'active');
  // Source cards collapse confirmed medications on the main list. Focus still counts real courses.
  const medications = snapshot.medicationCourses.filter(entry=>entry.status==='active');
  return {
    memberId, recordCount: entries.length, categoryCounts,
    pending: {
      reminderCount: reminders.length, reminders: reminders.slice(0,3),
      reviewCount: documents.filter(doc => doc.status === 'needs_review').length,
      processingCount: documents.filter(doc => ['queued','processing','uploading'].includes(doc.status)).length,
      failedCount: documents.filter(doc => doc.status === 'failed').length,
      documents: pendingDocuments.slice(0,2).map(documentEntry)
    },
    attention:{symptomCount:symptoms.length, medicationCount:medications.length,
      symptoms:symptoms.slice(0,2), medications:medications.slice(0,2)},
    processes:listRecordProcesses(user,memberId).slice(0,3),
    recentRecords:documents.slice(0,5).map(documentEntry)
  };
}
