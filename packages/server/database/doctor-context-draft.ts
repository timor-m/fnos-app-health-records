import type {DatabaseSync} from 'node:sqlite';
export const doctorBackgroundColumns=['care_allergies','care_history','care_medications'] as const;
function columns(db:DatabaseSync,table:string){return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name)));}
export function needsDoctorContextDraft(db:DatabaseSync){return doctorBackgroundColumns.some(key=>!columns(db,'health_members').has(key))||!columns(db,'health_record_process_metadata').has('visit_concern');}
/** Nullable independent additions: old clients can continue reading and writing. */
export function ensureDoctorContextDraft(db:DatabaseSync){
 db.exec('SAVEPOINT doctor_context');
 try{for(const key of doctorBackgroundColumns)if(!columns(db,'health_members').has(key))db.exec(`ALTER TABLE health_members ADD COLUMN ${key} TEXT`);
 if(!columns(db,'health_record_process_metadata').has('visit_concern'))db.exec('ALTER TABLE health_record_process_metadata ADD COLUMN visit_concern TEXT');
 db.exec('RELEASE doctor_context');}catch(error){db.exec('ROLLBACK TO doctor_context; RELEASE doctor_context');throw error;}
}
