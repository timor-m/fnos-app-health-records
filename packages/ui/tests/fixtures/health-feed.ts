import type { HealthFeedEntry } from '../../../shared/health-categories';
export function feedEntry(category:HealthFeedEntry['category'],kind:HealthFeedEntry['kind'],id=category):HealthFeedEntry {
 return {id:`${kind}:${id}`,category,kind,resourceId:id,memberId:'member',title:`合成${category}`,date:'2026-01-02',subtype:kind==='report'?'laboratory':kind==='medication_document'?'prescription':kind==='medication'?'course':kind==='intake'?'intake':kind==='vaccination'?'administered':kind==='measurement'?'manual':'symptom',description:null,status:null,institution:null,documents:[],processIds:[]};
}
export const feedEntries:HealthFeedEntry[]=[feedEntry('report','report'),{...feedEntry('imaging','report'),subtype:'imaging'},feedEntry('symptom','symptom'),feedEntry('monitoring','measurement'),feedEntry('medication','medication'),feedEntry('vaccination','vaccination')];
