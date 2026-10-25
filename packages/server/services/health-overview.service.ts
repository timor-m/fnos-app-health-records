import { listRecordProcesses } from './health-record-process.service';
import type { RequestUser } from '../domain/request-user';
import { healthCategories, reportCategory, type HealthFeedEntry } from '../../shared/health-categories';
import type { HealthOverview } from '../../shared/health-overview';
import { healthRecordSnapshot } from './health-record-feed.service';
import { listReminders } from './records.service';

/** Counts and recent cards use the same complete collection as the record list. */
export function getOverview(user: RequestUser, memberId: string): HealthOverview {
  const snapshot = healthRecordSnapshot(user, { memberId });
  const entries = snapshot.entries;
  const categoryCounts = Object.fromEntries(healthCategories.map(category => [category,
    entries.filter(entry => entry.category === category).length])) as HealthOverview['categoryCounts'];
  const reminders = listReminders(user, memberId).filter(item => item.status === 'pending');
  // Processing is a property of source documents, including evidence nested in confirmed records.
  const documents = [...new Map(entries.flatMap(entry => entry.documents).map(doc => [doc.id, doc])).values()];
  const priority = ['failed', 'needs_review', 'processing', 'uploading', 'queued'];
  const pendingDocuments = documents.filter(doc => priority.includes(doc.status)).sort((a,b) =>
    priority.indexOf(a.status)-priority.indexOf(b.status) || (Date.parse(b.reportIssuedAt||'')||0)-(Date.parse(a.reportIssuedAt||'')||0) || b.id.localeCompare(a.id));
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
      documents: pendingDocuments.slice(0,2).map(doc => ({
        id:`pending:${doc.id}`, resourceId:doc.id, memberId,
        kind:doc.reportType === 'prescription'?'medication_document':'report',
        category:reportCategory(doc.reportType), title:doc.title, date:doc.reportIssuedAt,
        subtype:doc.reportType, status:doc.status, institution:doc.hospitalName,
        description:null, documents:[doc], processIds:[]
      } satisfies HealthFeedEntry))
    },
    attention:{symptomCount:symptoms.length, medicationCount:medications.length,
      symptoms:symptoms.slice(0,2), medications:medications.slice(0,2)},
    processes:listRecordProcesses(user,memberId).slice(0,3),
    recentRecords:entries.slice(0,5)
  };
}
