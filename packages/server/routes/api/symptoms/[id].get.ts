import { createError, defineEventHandler, getRouterParam } from 'h3';
import { getDatabase } from '../../../database/client';
import { getHealthEpisode } from '../../../services/health-episode.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event=>{
 const symptomId=getRouterParam(event,'id',{decode:true})||'';
 const row=getDatabase().prepare('SELECT episode_id AS episodeId FROM health_process_symptoms WHERE id=? AND deleted_at IS NULL').get(symptomId);
 if(!row)throw createError({statusCode:404,statusMessage:'症状不存在'});
 return ok({episode:getHealthEpisode(getRequestUser(event),String(row.episodeId)),symptomId});
});
