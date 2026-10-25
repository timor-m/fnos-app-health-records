import {isTemperatureMeasurement,measurementsForSymptom} from '../../shared/symptom-measurements';
import {readDoctorContextForProcess} from './doctor-context.service';
import {reportStructuredSectionLabels} from './report-structured-section.service';
import type {ReportStructuredSectionKey} from '../domain/health-record';
import { formatMedicationFrequency } from '../../shared/medication-frequency';
import { processLifecycleLabels } from '../../shared/health-process';
import { createError } from 'h3';
import { getDatabase,runInTransaction } from '../database/client';
import type { RequestUser } from '../domain/request-user';
import { getRecordProcess } from './health-record-process.service';
import { readProcessSymptoms,createProcessSymptomUpdate } from './symptom-episode.service';
import { getMedicationCourse,getMedicationIntake,listCourseIntakes,createMedicationIntake } from './medication.service';
import { createPublicSymptom } from './public-symptom.service';
import { commonProcessSymptoms } from '../../shared/health-process-care';
import { assertMemberManage } from './member.service';
import { runHealthWorkflowRequest } from './health-workflow-request.service';
import { healthSymptomChangeLabels } from '../../shared/health-events';
import { medicationStatusLabels,medicationActionLabels,type MedicationIntake } from '../../shared/medications';
import type { HealthProcessDetail } from '../../shared/health-process';
import type { HealthProcessCare,ProcessQuickMedication,ProcessQuickRecordResult,TemperatureReading } from '../../shared/health-process-care';

const fail=(message:string,statusCode=400):never=>{throw createError({statusCode,statusMessage:message});};
const short=(value:unknown,max=240)=>{const text=String(value??'').replace(/\s+/g,' ').trim();return text.length>max?text.slice(0,max)+'…（节选，完整内容见原记录）':text;};
const doctorSectionKeys=new Set(['checkup_final_conclusion','checkup_abnormal_summary','checkup_positive_findings','checkup_original_recommendation','outpatient_disposition','outpatient_advice','inpatient_discharge_instructions','inpatient_course','pathology_grade','pathology_stage']);
function reportSummary(user:RequestUser,id:string){
 const db=getDatabase(),report=db.prepare(`SELECT chief_complaint AS chiefComplaint,summary,impression,recommendation FROM reports r
   JOIN member_permissions mp ON mp.member_id=r.member_id AND mp.user_id=? WHERE r.id=? AND r.status<>'trashed' AND r.deleted_at IS NULL`).get(user.id,id);
 if(!report)return fail('报告不存在或无权访问',404);
 const sections=db.prepare(`SELECT section_key AS sectionKey,section_title AS title,content_text AS content,source
   FROM report_structured_sections WHERE report_id=? AND is_deleted=0 AND section_key IN (SELECT value FROM json_each(?))`).all(id,JSON.stringify([...doctorSectionKeys]));
 const seen=new Set<string>(),lines:string[]=[];
 const add=(label:string,value:unknown)=>{const text=String(value??'').trim();if(!text||seen.has(text))return;seen.add(text);lines.push(label+'：'+short(text,1200));};
 add('原报告主诉',report.chiefComplaint);add('报告结论',report.summary);add('报告印象',report.impression);
 for(const section of sections)add(section.source==='manual'?String(section.title):reportStructuredSectionLabels[section.sectionKey as ReportStructuredSectionKey],section.content);
 add('原报告建议',report.recommendation);return lines;
}
function memberAge(birth:string|null,today:string){
 if(!birth||!/^\d{4}-\d{2}-\d{2}$/.test(birth)||birth>today)return '';
 const [y,m,d]=birth.split('-').map(Number),[ty,tm,td]=today.split('-').map(Number);let months=(ty-y)*12+tm-m-(td<d?1:0);return months<0?'未满1个月':months<24?months+'个月':Math.floor(months/12)+'岁';
}
const temperatureName=(name:string)=>measurementsForSymptom(name).some(item=>item.id==='temperature');
function timeTools(timeZone:string){
 let formatter:Intl.DateTimeFormat;
 try{if(!timeZone||timeZone.length>100)throw Error();formatter=new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{ return fail('查看时区无效'); }
 const display=(value:string|null)=>!value?'日期未记录':/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)?formatter.format(new Date(value)):value.replace('T',' ').slice(0,16);
 return {display,day:(value:string)=>display(value).slice(0,10)};
}
export function careRecords(user:RequestUser,process:HealthProcessDetail,options:{reports?:boolean;summary?:boolean}={}){
 const db=getDatabase();
 const symptoms=process.records.filter(r=>r.ref.kind==='symptom').map(record=>{
  const row=db.prepare('SELECT episode_id AS episodeId FROM health_process_symptoms WHERE id=? AND deleted_at IS NULL').get(record.ref.id)!;
  const symptom=readProcessSymptoms(String(row.episodeId),record.ref.id).find(s=>s.id===record.ref.id)!;
  return {...symptom,updates:symptom.updates.filter(u=>!u.deletedAt).sort((a,b)=>Date.parse(a.recordedAt)-Date.parse(b.recordedAt)||a.id.localeCompare(b.id))};
 });
 const courses=process.records.filter(r=>r.ref.kind==='medication').map(r=>getMedicationCourse(user,r.ref.id));
 const intakes=new Map<string,MedicationIntake>();
 const memberIntakes=listCourseIntakes(user,process.memberId,courses.map(course=>course.id));
 for(const course of courses)for(const intake of memberIntakes.filter(i=>i.courseId===course.id))intakes.set(intake.id,intake);
 for(const record of process.records.filter(r=>r.ref.kind==='intake')){const intake=getMedicationIntake(user,record.ref.id);intakes.set(intake.id,intake);}
 const allIntakes=[...intakes.values()].sort((a,b)=>Date.parse(a.takenAt)-Date.parse(b.takenAt)||a.id.localeCompare(b.id));
 const medications:Array<ProcessQuickMedication&{courseId:string|null;sourceMedicationId?:string;sourceIntakeId?:string;specification:string|null;dosageForm:string|null;route:string|null}> = [];
 for(const course of courses){
  const last=allIntakes.filter(i=>i.courseId===course.id&&i.medicationName===course.medicationName&&i.specification===course.specification&&i.dosageForm===course.dosageForm&&i.route===course.route).at(-1);
  medications.push({key:'course:'+course.id,name:course.medicationName,origin:'course',status:course.status,courseId:course.id,
   specification:course.specification,dosageForm:course.dosageForm,route:course.route,
   detail:[course.specification,formatMedicationFrequency(course.frequency),course.route,medicationStatusLabels[course.status]].filter(Boolean).join(' · '),amount:last?.amount||'',unit:last?.amountUnit||'',lastTakenAt:last?.takenAt||null});
 }
 const reports=(options.reports===false?[]:process.records.filter(r=>['report','medication_document'].includes(r.ref.kind))).map(record=>{
  const diagnoses=options.summary===false?[]:db.prepare('SELECT diagnosis_text AS text FROM report_diagnoses WHERE report_id=? AND is_deleted=0 ORDER BY is_primary DESC,id').all(record.ref.id).map(r=>String(r.text));
  const report=options.summary===false?{diagnosis:null,department:null}:db.prepare('SELECT clinical_diagnosis AS diagnosis,visit_department AS department FROM reports WHERE id=?').get(record.ref.id)!;
  if(report.diagnosis&&!diagnoses.includes(String(report.diagnosis)))diagnoses.push(String(report.diagnosis));
  const drugs=db.prepare('SELECT id,medication_name AS name,specification,dosage_form AS dosageForm,dose,dose_unit AS doseUnit,frequency,route FROM report_medications WHERE report_id=? AND is_deleted=0 ORDER BY id').all(record.ref.id);
  for(const drug of drugs)if(!courses.some(c=>c.source?.medicationId===drug.id))medications.push({key:'prescription:'+drug.id,name:String(drug.name),origin:'prescription',status:null,courseId:null,sourceMedicationId:String(drug.id),specification:drug.specification as string|null,dosageForm:drug.dosageForm as string|null,route:drug.route as string|null,
   detail:[record.title,drug.specification].filter(Boolean).join(' · '),amount:'',unit:'',lastTakenAt:null});
  const procedures=options.summary===false?[]:db.prepare('SELECT procedure_name AS name FROM report_procedures WHERE report_id=? AND is_deleted=0 ORDER BY id').all(record.ref.id).map(p=>String(p.name));
  return {record,department:report.department as string|null,diagnoses,drugs,procedures};
 });
 const standalone=new Map<string,MedicationIntake>();
 for(const intake of allIntakes)if(!courses.some(c=>c.id===intake.courseId)){
  const prescription=medications.find(m=>m.origin==='prescription'&&!intake.courseId&&intake.sourceReportId&&m.sourceMedicationId===intake.source?.medicationId&&m.name===intake.medicationName&&m.specification===intake.specification&&m.dosageForm===intake.dosageForm&&m.route===intake.route);
  if(prescription){prescription.amount=intake.amount;prescription.unit=intake.amountUnit||'';prescription.lastTakenAt=intake.takenAt;}else standalone.set(JSON.stringify([intake.courseId,intake.sourceReportId,intake.source?.medicationId,intake.medicationName,intake.specification,intake.dosageForm,intake.route]),intake);
 }
 for(const intake of standalone.values())medications.push({key:'intake:'+intake.id,name:intake.medicationName,origin:'intake',status:null,courseId:intake.courseId,sourceIntakeId:intake.id,specification:intake.specification,dosageForm:intake.dosageForm,route:intake.route,detail:[intake.specification,intake.route,'曾记录服用'].filter(Boolean).join(' · '),amount:intake.amount,unit:intake.amountUnit||'',lastTakenAt:intake.takenAt});
 return {symptoms,courses,intakes:allIntakes,medications,reports};
}

/** Rules-only view over original records; no AI, copied clinical facts or inferred diagnoses. */
export function getHealthProcessCare(user:RequestUser,id:string,timeZone='Asia/Shanghai',summary=true):HealthProcessCare {
 return buildHealthProcessCare(user,getRecordProcess(user,id),timeZone,summary);
}
/** Build one view from the same authorized snapshot as the other initial modules. */
export function buildHealthProcessCare(user:RequestUser,process:HealthProcessDetail,timeZone='Asia/Shanghai',summary=true,source=careRecords(user,process,{summary})):HealthProcessCare {
 const {display,day}=timeTools(timeZone);
 const readings:TemperatureReading[]=[];
 for(const symptom of source.symptoms)for(const update of symptom.updates){
  const value=(update.temperatureValue??(temperatureName(symptom.name)?update.measurementValue:null))?.normalize('NFKC').trim();
  if(isTemperatureMeasurement(value,update.temperatureValue?'℃':update.measurementUnit))readings.push({value:Number(value),at:update.recordedAt,symptomId:symptom.id,updateId:update.id});
 }
 readings.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.updateId.localeCompare(b.updateId));
 const highest=[...readings].sort((a,b)=>b.value-a.value||Date.parse(b.at)-Date.parse(a.at))[0];
 const temperature=highest?{highest,latest:readings.at(-1)!,count:readings.length,recordedDays:new Set(readings.map(r=>day(r.at))).size,threshold:37.5,thresholdDays:new Set(readings.filter(r=>r.value>=37.5).map(r=>day(r.at))).size,readings}:null;
 const quick:HealthProcessCare={processId:process.id,memberId:process.memberId,fingerprint:process.fingerprint,summaryText:'',summaryReady:false,temperature,
  symptoms:source.symptoms.map(s=>{const latest=s.updates.at(-1);return {id:s.id,name:s.name,status:s.status,unit:s.updates.filter(u=>u.measurementUnit).at(-1)?.measurementUnit||(temperatureName(s.name)?'℃':null),...(latest?{latest:{recordedAt:latest.recordedAt,change:latest.change,measurementValue:latest.measurementValue,measurementUnit:latest.measurementUnit,temperatureValue:latest.temperatureValue,severity:latest.severity}}:{})};}),
  medications:source.medications.map(({courseId,sourceMedicationId,sourceIntakeId,specification,dosageForm,route,...choice})=>choice)};
 if(!summary)return quick;
 const member=getDatabase().prepare('SELECT display_name AS name,birth_date AS birthDate,sex FROM health_members WHERE id=?').get(process.memberId)!;
 const context=readDoctorContextForProcess(user,process);
 const lines=[`【就诊摘要】${short(member.name)}${member.sex==='male'?'｜男':member.sex==='female'?'｜女':''}${member.birthDate?'｜出生 '+member.birthDate+(memberAge(String(member.birthDate),day(new Date().toISOString()))?'（'+memberAge(String(member.birthDate),day(new Date().toISOString()))+'）':''):''}`,`健康历程：${process.title}`,`记录范围：${display(process.startedAt)}${process.latestAt&&process.latestAt!==process.startedAt?' ～ '+display(process.latestAt):''}`];
 if(process.lifecycle&&(process.lifecycle.status!=='unknown'||process.lifecycle.onsetAt))lines.push(`历程状态：${processLifecycleLabels[process.lifecycle.status]}${process.lifecycle.onsetAt?'｜起病／开始 '+process.lifecycle.onsetAt:''}${process.lifecycle.endedAt?'｜结束 '+process.lifecycle.endedAt:''}`);
 lines.push('','【本次诉求 · 用户填写】',context.concern||'未填写','', '【重要健康背景 · 用户填写】','过敏及不良反应：'+(context.allergies||'未填写'),'重要病史：'+(context.history||'未填写'),'长期用药（自述）：'+(context.medications||'未填写'));
 const header=[...lines];
 const reportDetails=new Map(source.reports.map(({record})=>[record.ref.id,reportSummary(user,record.ref.id)]));
 if(source.symptoms.length){lines.push('','【症状与变化】');for(const symptom of source.symptoms){
  lines.push(`${symptom.name}｜开始 ${display(symptom.startedAt)}｜${symptom.status==='resolved'?'已消失':symptom.status==='active'?'持续跟踪':'状态未知'}${symptom.description?'｜'+short(symptom.description):''}`);
  if(symptom.bodyArea)lines.push('部位：'+short(symptom.bodyArea));if(symptom.frequency)lines.push('发生频率：'+short(symptom.frequency));if(symptom.relievingText)lines.push('记录的缓解因素：'+short(symptom.relievingText));if(symptom.associatedSymptomsText)lines.push('伴随症状：'+short(symptom.associatedSymptomsText));
  if(symptom.triggerText)lines.push('记录的诱因：'+short(symptom.triggerText));
  if(symptom.updates.length>3)lines.push(`共 ${symptom.updates.length} 次变化，以下为最近 3 次：`);
  for(const update of symptom.updates.slice(-3))lines.push(`  ${display(update.recordedAt)} ${[update.change?healthSymptomChangeLabels[update.change]:'',update.severity!==null?'程度 '+update.severity+'/10':'',update.measurementValue?update.measurementValue+' '+update.measurementUnit:'',update.temperatureValue?'体温 '+update.temperatureValue+' ℃':'',short(update.description)].filter(Boolean).join('；')}`);
 }}
 if(temperature)lines.push('','【体温小结】',`最高 ${temperature.highest.value}℃（${display(temperature.highest.at)}）；最近 ${temperature.latest.value}℃（${display(temperature.latest.at)}）`,`共 ${temperature.count} 次，覆盖 ${temperature.recordedDays} 天；有 ≥${temperature.threshold}℃ 记录的日期共 ${temperature.thresholdDays} 天（仅按已保存记录统计）`);
 if(source.reports.length){lines.push('','【就诊与报告】');for(const {record,department,diagnoses,drugs,procedures} of source.reports){
  lines.push(`${display(record.date)}｜${record.institution||'机构未记录'}${department?' · '+department:''}｜${record.title}`);
  if(diagnoses.length)lines.push('报告诊断：'+diagnoses.map(d=>short(d)).join('；'));
  if(drugs.length)lines.push('报告所列用药（不代表已服用）：'+drugs.map(m=>[m.name,m.specification,[m.dose,m.doseUnit].filter(Boolean).join(''),formatMedicationFrequency(m.frequency),m.route].filter(Boolean).join(' ')).join('；'));
  lines.push(...reportDetails.get(record.ref.id)!);
  if(procedures.length)lines.push('报告所列操作（执行情况以原报告为准）：'+procedures.join('；'));
 }}
 if(source.courses.length){lines.push('','【已确认用药】');for(const course of source.courses)lines.push(`${course.medicationName}｜${medicationStatusLabels[course.status]}｜${[course.specification,[course.dose,course.doseUnit].filter(Boolean).join(''),formatMedicationFrequency(course.frequency),course.route].filter(Boolean).join(' · ')}｜开始 ${display(course.startedAt)}${course.stoppedAt?'｜停止 '+display(course.stoppedAt):''}`);}
 if(source.intakes.length){lines.push('','【实际服药】',`共 ${source.intakes.length} 次${source.intakes.length>20?'，以下为最近 20 次':''}`);
  const days=new Map<string,number>();for(const intake of source.intakes){const key=day(intake.takenAt)+' '+intake.medicationName+(intake.specification?'（'+intake.specification+'）':'');days.set(key,(days.get(key)||0)+1);}lines.push('每日服药记录：'+[...days].map(([label,count])=>label+' '+count+'次').join('；'));
  for(const intake of source.intakes.slice(-20))lines.push(`${display(intake.takenAt)}｜${intake.medicationName} ${intake.amount}${intake.amountUnit||''}${intake.note?'｜'+short(intake.note):''}`);
 }
 const others=process.records.filter(r=>r.ref.kind==='vaccination');if(others.length){lines.push('','【接种记录】');for(const record of others)lines.push(`${display(record.date)}｜${record.title}${record.description?'｜'+record.description:''}`);}
 const events:Array<{at:string|null;text:string}>=[];
 const event=(at:string|null,text:string)=>events.push({at,text});
 for(const symptom of source.symptoms){event(symptom.startedAt,`开始跟踪：${symptom.name}`);for(const update of symptom.updates)event(update.recordedAt,`症状 ${symptom.name}：${[update.change?healthSymptomChangeLabels[update.change]:'',update.measurementValue?update.measurementValue+' '+(update.measurementUnit||''):'',update.temperatureValue?'体温 '+update.temperatureValue+' ℃':'',update.severity!==null?'程度 '+update.severity+'/10':'',short(update.description)].filter(Boolean).join('；')||'补充记录'}`);}
 for(const {record,diagnoses,drugs,procedures} of source.reports)event(record.date,`报告：${record.title}｜${record.institution||'机构未记录'}${diagnoses.length?'｜报告诊断：'+diagnoses.join('；'):''}${drugs.length?'｜报告所列用药（不代表已服用）：'+drugs.map(m=>[m.name,m.specification,[m.dose,m.doseUnit].filter(Boolean).join(''),formatMedicationFrequency(m.frequency),m.route].filter(Boolean).join(' ')).join('；'):''}${procedures.length?'｜报告所列操作：'+procedures.join('；'):''}${reportDetails.get(record.ref.id)!.length?'\n    '+reportDetails.get(record.ref.id)!.join('\n    '):''}`);
 for(const course of source.courses)for(const change of course.changes)event(change.occurredAt,`已确认用药 ${course.medicationName}：${medicationActionLabels[change.action]}｜${[change.snapshot.dose,change.snapshot.doseUnit,formatMedicationFrequency(change.snapshot.frequency),change.note].filter(Boolean).join(' ')}`);
 for(const intake of source.intakes)event(intake.takenAt,`实际服药：${intake.medicationName} ${intake.specification||''} ${intake.amount}${intake.amountUnit||''}${intake.note?'｜'+short(intake.note):''}`);
 for(const record of others)event(record.date,`接种：${record.title}${record.description?'｜'+record.description:''}`);
 events.sort((a,b)=>(a.at?Date.parse(a.at):Infinity)-(b.at?Date.parse(b.at):Infinity)||a.text.localeCompare(b.text));
 const daily=[...header];if(events.length>200)daily.push(`共 ${events.length} 条，以下按天节选最近 200 条：`);
 let previousDay='';for(const entry of events.slice(-200)){const key=entry.at?day(entry.at):'日期未记录';if(key!==previousDay){daily.push('',key);previousDay=key;}daily.push(`  ${entry.at?display(entry.at).slice(11):''} ${entry.text}`.trimEnd());}
 return {...quick,summaryReady:true,summaryText:lines.join('\n'),summaryByDay:daily.join('\n'),doctorContext:context};
}

export function quickRecordProcess(user:RequestUser,id:string,input:Record<string,unknown>):ProcessQuickRecordResult {
 const process=getRecordProcess(user,id);assertMemberManage(user,process.memberId);
 return runHealthWorkflowRequest(user,process.memberId,'process.quick-record',{...input,processId:id},()=>runInTransaction(getDatabase(),()=>{
  const current=getRecordProcess(user,id);if(input.fingerprint!==current.fingerprint)return fail('历程记录已变化，请重新打开后保存',409);
  if(typeof input.recordedAt!=='string'||!input.recordedAt.trim())return fail('请选择记录时间');
  const source=careRecords(user,current);
  if(input.kind==='symptom'||input.kind==='new_symptom'){
   let symptom=source.symptoms.find(s=>s.id===input.target);
   if(input.kind==='new_symptom'){
    if(!commonProcessSymptoms.some(name=>name===input.target))return fail('请选择常用症状');
    symptom=source.symptoms.find(s=>s.name===input.target);
    if(!symptom){const created=createPublicSymptom(user,{memberId:process.memberId,name:input.target,startedAt:input.recordedAt,processId:id});symptom=readProcessSymptoms(created.episodeId).find(s=>s.id===created.id);}
   }
if(!symptom)return fail('症状不在当前历程中',409);
   const before=new Set(symptom.updates.map(u=>u.id));
   createProcessSymptomUpdate(user,symptom.episodeId,symptom.id,{recordedAt:input.recordedAt,change:input.change??null,severity:input.severity??null,temperatureValue:input.temperatureValue||null,measurementValue:input.measurementValue||null,measurementUnit:input.measurementValue?input.measurementUnit:null,description:input.description||null});
   const created=readProcessSymptoms(symptom.episodeId).find(s=>s.id===symptom.id)!.updates.find(u=>!before.has(u.id))!;
   return {processId:id,memberId:process.memberId,kind:'symptom',id:created.id,symptomId:symptom.id,fingerprint:getRecordProcess(user,id).fingerprint,label:[symptom.name,created.measurementValue,created.measurementUnit,created.temperatureValue?'体温 '+created.temperatureValue+' ℃':null].filter(Boolean).join(' '),recordedAt:created.recordedAt};
  }
  if(input.kind!=='medication')return fail('记录类型无效');
  const medication=source.medications.find(m=>m.key===input.target);if(!medication)return fail('药品不在当前历程中',409);
  const intake=createMedicationIntake(user,{memberId:process.memberId,processId:id,courseId:medication.courseId,sourceMedicationId:medication.sourceMedicationId,sourceIntakeId:medication.sourceIntakeId,medicationName:medication.name,specification:medication.specification,dosageForm:medication.dosageForm,route:medication.route,takenAt:input.recordedAt,amount:input.amount,amountUnit:input.amountUnit,note:input.description});
  return {processId:id,memberId:process.memberId,kind:'intake',id:intake.id,fingerprint:getRecordProcess(user,id).fingerprint,label:[intake.medicationName,intake.amount,intake.amountUnit].filter(Boolean).join(' '),recordedAt:intake.takenAt};
 }),saved=>{
  const current=getRecordProcess(user,id);if(current.memberId!==process.memberId)return fail('历程所属成员已变化',409);
  if(saved.kind==='intake'){const intake=getMedicationIntake(user,saved.id);if(intake.memberId!==current.memberId||!current.records.some(r=>r.ref.kind==='intake'&&r.ref.id===intake.id))return fail('已保存记录已变化，请刷新后核对',409);}
  else if(!current.records.some(r=>r.ref.kind==='symptom'&&r.ref.id===(saved.symptomId||input.target))||!getDatabase().prepare('SELECT id FROM health_process_symptom_updates WHERE id=? AND symptom_id=? AND deleted_at IS NULL').get(saved.id,String(saved.symptomId||input.target)))return fail('已保存记录已变化，请刷新后核对',409);
  return saved;
 });
}
