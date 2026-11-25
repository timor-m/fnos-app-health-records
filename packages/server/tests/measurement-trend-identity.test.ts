import {trendCardKey} from '../../shared/trend-card';
import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementTrendIdentity,parseMeasurementSeriesKey,measurementBaseKey} from '../../shared/measurement-trend-identity';
import {measurementIndicatorDefinitions,type MeasurementIndicatorDefinition} from '../../shared/measurement-indicators';
import {boneSeriesIdentity,parseBoneSeriesKey,boneCardMetricKeys} from '../../shared/bone-density';
import {cardiacSeriesIdentity,parseCardiacSeriesKey} from '../../shared/cardiac-measurements';

test('existing bone and cardiac encodings stay byte-for-byte compatible with pins and unknown-context keys',()=>{
 for(const metric of ['dxa_bmd','dxa_t_score','dxa_z_score'])for(const site of ['lumbar_l1','femur_neck','femur_total'])for(const side of ['left','right','unspecified']){
  const old=`${metric}@${site}@${side}`;
  assert.equal(measurementTrendIdentity(metric,{measurementSite:site,measurementLaterality:side,method:'DXA'}),old);
  assert.equal(boneSeriesIdentity(metric,site,side),old);assert.equal(measurementBaseKey(old),metric);assert.equal(parseBoneSeriesKey(old)?.group,`${site}@${side}`);
 }
 const old='cardiac_lvef@cardiac@left_ventricle@超声心动图@二维simpson双平面法';
 const context={measurementSite:'left_ventricle',examinationModality:'超声心动图',method:'二维Simpson 双平面法'};
 assert.equal(measurementTrendIdentity('cardiac_lvef',context),old);assert.equal(cardiacSeriesIdentity('cardiac_lvef',context.measurementSite,context.examinationModality,context.method),old);
 assert.equal(parseCardiacSeriesKey(old)?.method,'二维simpson双平面法');assert.equal(measurementBaseKey(old),'cardiac_lvef');
 assert.equal(measurementTrendIdentity('cardiac_lvef',{method:'M型'}),'cardiac_lvef');
 for(const metric of ['hip_axis_length_left','hip_axis_length_right']){assert.equal(measurementTrendIdentity(metric,{method:'DXA'}),metric);assert.notEqual(measurementTrendIdentity(metric,{examinationModality:'CT',method:'合成测量法'}),metric);}
 assert.equal(measurementTrendIdentity('dxa_bmd',{}),'dxa_bmd');assert.equal(measurementTrendIdentity('dxa_bmd',{measurementSite:'not-a-site'}),'dxa_bmd');
 assert.equal(measurementTrendIdentity('laboratory_ck',context),'laboratory_ck');assert.equal(measurementTrendIdentity('cardiac_nt_probnp',context),'cardiac_nt_probnp');
 assert.equal(cardiacSeriesIdentity('dxa_bmd','femur_neck','CT','合成方法'),'dxa_bmd');assert.equal(boneSeriesIdentity('cardiac_lvef','left_ventricle','left'),'cardiac_lvef');
});
test('a new declared CT metric uses the common engine without a domain branch and separates all four dimensions',()=>{
 const definition:MeasurementIndicatorDefinition={dimensions:['method','examinationModality','measurementLaterality','measurementSite']};
 const base={measurementSite:'synthetic_region',measurementLaterality:'left',examinationModality:'CT',method:'合成方法 @ A %'};
 const key=measurementTrendIdentity('synthetic_ct_metric',base,definition);const parsed=parseMeasurementSeriesKey(key,definition)!;
 assert.equal(parsed.metric,'synthetic_ct_metric');assert.equal(parsed.context.method,'合成方法@a%');assert.equal(parsed.context.measurementLaterality,'left');
 for(const change of [{measurementSite:'other_region'},{measurementLaterality:'right'},{examinationModality:'MRI'},{method:'合成方法B'}])assert.notEqual(measurementTrendIdentity('synthetic_ct_metric',{...base,...change},definition),key);
 assert.equal(measurementTrendIdentity('synthetic_ct_metric',base,{dimensions:['measurementSite','measurementLaterality','examinationModality','method']}),key,'declaration order cannot change stable identity');
 assert.notEqual(measurementTrendIdentity('synthetic_ct_metric',{},definition),key);
 const siteOnly:MeasurementIndicatorDefinition={dimensions:['measurementSite']};assert.equal(measurementTrendIdentity('synthetic_site_only',base,siteOnly),measurementTrendIdentity('synthetic_site_only',{...base,method:'other',examinationModality:'MRI'},siteOnly));
 assert.equal(parseMeasurementSeriesKey('synthetic_ct_metric@measurement@bad',definition),null);assert.equal(parseMeasurementSeriesKey('synthetic_ct_metric@measurement@%ZZ@left@CT@method',definition),null);
});
test('bone UI groups only equal complete contexts and pin peers keep the same context',()=>{
 const context={measurementSite:'femur_total',measurementLaterality:'left',examinationModality:'DXA',method:'合成方法A'};
 const key=measurementTrendIdentity('dxa_bmd',context),bone=parseBoneSeriesKey(key)!;assert.ok(bone);
 assert.notEqual(bone.group,parseBoneSeriesKey(boneSeriesIdentity('dxa_bmd','femur_total','left'))!.group);
 assert.notEqual(bone.group,parseBoneSeriesKey(measurementTrendIdentity('dxa_bmd',{...context,method:'合成方法B'}))!.group);
 assert.deepEqual(boneCardMetricKeys(key),['dxa_bmd','dxa_t_score','dxa_z_score'].map(metric=>measurementTrendIdentity(metric,context)));
 assert.ok(boneCardMetricKeys(key)!.every(peer=>parseBoneSeriesKey(peer)?.group===bone.group));
 const cardiac=measurementTrendIdentity('cardiac_lvef',{measurementSite:'left_ventricle',examinationModality:'超声心动图',measurementLaterality:'left'});
 assert.equal(cardiac,measurementTrendIdentity('cardiac_lvef',{measurementSite:'left_ventricle',examinationModality:'超声心动图',measurementLaterality:'right'}),'undeclared laterality cannot affect cardiac identity');
});
test('every shipped dimension declaration round-trips through its own identity',()=>{
 for(const [metric,definition] of Object.entries(measurementIndicatorDefinitions)){
  const context={measurementSite:definition.allowedSites?.[0] || 'left_ventricle',measurementLaterality:'left',examinationModality:definition.defaultModality || 'CT',method:'Synthetic method'};
  const key=measurementTrendIdentity(metric,context);assert.equal(parseMeasurementSeriesKey(key)?.metric,metric);assert.equal(measurementBaseKey(key),metric);
 }
});

test('presentation cards collapse only method and modality while source identities, sites, sides and units stay isolated',()=>{
 const a=cardiacSeriesIdentity('cardiac_lvef','left_ventricle','超声心动图','方法A');
 const b=cardiacSeriesIdentity('cardiac_lvef','left_ventricle','CT','方法B');
 assert.notEqual(a,b);assert.equal(trendCardKey(a,'%'),trendCardKey(b,'%'));
 assert.notEqual(trendCardKey(a,'%'),trendCardKey(a,'other'));
 assert.notEqual(trendCardKey(a,'%'),trendCardKey(cardiacSeriesIdentity('cardiac_lvef','right_ventricle','CT','方法B'),'%'));
 assert.notEqual(trendCardKey(a,'%'),trendCardKey('cardiac_lvef','%'));
 assert.notEqual(trendCardKey('institution:a','mm'),trendCardKey('institution:b','mm'));
 assert.notEqual(trendCardKey('hip_axis_length_left','mm'),trendCardKey('hip_axis_length_right','mm'));
 assert.equal(trendCardKey(boneSeriesIdentity('dxa_bmd','femur_total','left'),'g/cm2'),trendCardKey(boneSeriesIdentity('dxa_t_score','femur_total','left'),null));
 assert.notEqual(trendCardKey(boneSeriesIdentity('dxa_bmd','femur_total','left')),trendCardKey(boneSeriesIdentity('dxa_bmd','femur_total','right')));
});
