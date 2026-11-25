import type {DatabaseSync} from 'node:sqlite';
const additions=['measurement_site','measurement_laterality','examination_modality'] as const;
function columns(db:DatabaseSync){return new Set(db.prepare('PRAGMA table_info(observations)').all().map(row=>String(row.name)));}
export function needsBoneDensityDraft(db:DatabaseSync){return additions.some(column=>!columns(db).has(column));}
/** Independent nullable metadata: older clients ignore it; raw observations remain intact. */
export function ensureBoneDensityDraft(db:DatabaseSync){
 for(const column of additions)if(!columns(db).has(column))db.exec(`ALTER TABLE observations ADD COLUMN ${column} TEXT`);
}
