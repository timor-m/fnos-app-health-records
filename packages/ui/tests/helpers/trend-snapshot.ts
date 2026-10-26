import {splitMeasurementBound} from '../../../shared/measurement-result';
import { vi } from 'vitest';

// Fixture formatting only; individual tests explicitly choose search/filter results.
export const snapshotKey = (item:any) => JSON.stringify([item.indicatorKey,item.unit || '']);
export function snapshotPage(items:any[], groups:any[] = [], version=1) {
  const summaries=items.map(item=>({...item,snapshotKey:snapshotKey(item),excludedPointCount:item.excludedPoints?.length || 0,
    points:item.points.slice(-6),excludedPoints:[],chartLoaded:false,detailLoaded:false}));
  const sectionMap=new Map<string,any>();
  for(const item of items) {
    if(!sectionMap.has(item.groupKey))sectionMap.set(item.groupKey,{key:item.groupKey,name:item.groupName,sortOrder:item.groupOrder,count:0,pointCount:0,abnormalCount:0,subgroups:[]});
    const section=sectionMap.get(item.groupKey);section.count++;section.pointCount+=item.pointCount;
    if(item.attentionLevel==='abnormal')section.abnormalCount++;
    const key=item.subgroupKey || 'laboratory_other';
    let subgroup=section.subgroups.find((group:any)=>group.key===key);
    if(!subgroup){subgroup={key,name:item.subgroupName || '其他检验',sortOrder:item.subgroupOrder,count:0};section.subgroups.push(subgroup);}
    subgroup.count++;
  }
  return {version,status:'ready',desiredRevision:version,items:summaries,total:items.length,pointCount:items.reduce((sum,item)=>sum+item.pointCount,0),
    pinnedCount:items.filter(item=>item.pinned).length,groups,sections:[...sectionMap.values()],hasMore:false,nextCursor:null};
}
export function snapshotOverview(items:any[], groups:any[] = [], version=1) {
  const all=snapshotPage(items,groups,version),normal=snapshotPage(items.filter(item=>!item.pinned),groups,version),first=normal.sections[0];
  return {...all,sections:normal.sections,items:[],pinned:snapshotPage(items.filter(item=>item.pinned),groups,version),
    firstSection:first ? {...snapshotPage(items.filter(item=>!item.pinned && item.groupKey===first.key),groups,version),key:first.key} : null};
}
export function snapshotParts(items:any[], init?:RequestInit, version=1) {
  const body=JSON.parse(String(init?.body));
  return {version,items:items.filter(item=>body.keys.includes(snapshotKey(item))).map(item=>({key:snapshotKey(item),data:item.points}))};
}
export function autoChartViewport() {
  vi.stubGlobal('IntersectionObserver',class {
    constructor(private callback:any){}
    observe(element:HTMLElement){this.callback([{target:element,isIntersecting:element.classList.contains('trend-chart-scroll')}]);}
    unobserve(){} disconnect(){}
  });
}

export function sampleTrend(texts: string[]) {
  const points = texts.map((resultText, i) => ({
    observationId: `o-${i}`, reportId: `r-${i}`, reportTitle: '合成报告', reportIssuedAt: `2026-01-0${i + 1}`,
    itemName: '合成指标', numericValue: Number(splitMeasurementBound(resultText).text), resultText,
    resultComparator: splitMeasurementBound(resultText).comparator, referenceLow: 1, referenceHigh: 8,
    referenceStatus: 'trusted', referenceText: '1-8', abnormalFlag: null, displayAbnormalFlag: null,
    reportedAbnormalFlag: null, abnormalConflict: false, abnormalStatus: 'unresolved',
    abnormalSource: 'none', sourcePage: null, sourceLineIds: [], resultLineIds: [],
  }));
  return {indicatorKey: 'synthetic', name: '合成指标', unit: 'U/L', kind: 'standard', quality: 'high',
    groupKey: 'laboratory', groupName: '实验室检查', groupOrder: 1, subgroupOrder: 1, itemOrder: 1,
    searchAliases: [], sourceNames: [], matchReasons: [], excludedPoints: [], points, pointCount: points.length,
    latestValue: null, previousValue: null, delta: null, typicalMinValue: null, typicalMaxValue: null,
    attentionLevel: null, abnormalContinuityStatus: 'none', comparabilityStatus: 'comparable', comparable: true,
    latestChangeStatus: 'not_comparable', latestChangeMagnitude: 'unavailable',
    latestChangeReason: '限值结果已保留，不参与精确差值或升降计算',
    trendStatus: 'insufficient_evidence', trendReason: '包含限值结果',
    firstDate: points[0].reportIssuedAt, lastDate: points.at(-1)!.reportIssuedAt};
}
