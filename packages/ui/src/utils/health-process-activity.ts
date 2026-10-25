import type {ActivityResult,HealthProcessActivity} from '../../../shared/health-process-activity';
import type {HealthProcessDetail} from '../../../shared/health-process';
/** Await the request started beside the primary detail request, without retaining cross-member data. */
type ActivityData={ [K in 'care'|'observations'|'reminders']:NonNullable<HealthProcessActivity[K]['data']> };
export async function initialProcessActivity<K extends 'care'|'observations'|'reminders'>(pending:Promise<HealthProcessActivity>,process:Pick<HealthProcessDetail,'id'|'memberId'> & {fingerprint?:string},kind:K):Promise<ActivityData[K]|undefined>{
 const result=await pending;
 if(!result||result.processId!==process.id||result.memberId!==process.memberId||!result[kind])throw Error('模块数据与当前历程不一致');
 // A write between the two parallel requests must fall back to a fresh read.
 if(process.fingerprint&&result.fingerprint!==process.fingerprint)return undefined;
 const section=result[kind] as ActivityResult<ActivityData[K]>;if(section.error)throw Error(section.error);
 return section.data;
}
