import {snapshotOverview,snapshotParts,autoChartViewport} from './helpers/trend-snapshot';
import {afterEach,beforeEach, expect, it, vi} from 'vitest';
import {flushPromises, shallowMount} from '@vue/test-utils';
import {ref} from 'vue';
import TrendsPage from '../src/pages/TrendsPage.vue';
import {splitMeasurementBound} from '../../shared/measurement-result';

const {request, context} = vi.hoisted(() => ({request: vi.fn(), context: {app: null as any}}));
vi.mock('../src/utils/api', async original => ({...await original<typeof import('../src/utils/api')>(),request, apiUrl: (path: string) => path}));
vi.mock('../src/composables/useAppContext', () => ({useAppContext: () => context.app}));
vi.mock('../src/composables/useRefreshOnActivate', () => ({useRefreshOnActivate: () => {}}));
vi.mock('vue-router', () => ({useRoute: () => ({path: '/trends', query: {}})}));

beforeEach(() => {
  localStorage.clear();autoChartViewport();
  context.app = {selectedMemberId: ref('synthetic-member'), session: ref({isAdmin: false}),
    setTopbarSubtitle: vi.fn(), clearTopbarSubtitle: vi.fn(), setTopbarSearch: vi.fn(), clearTopbarSearch: vi.fn()};
  request.mockReset();
});

function series(texts: string[]) {
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

it('shows only the calendar date on chart nodes while retaining precise source times', async () => {
  const item = series(['2', '3']);
  Object.assign(item.points[0], {reportIssuedAt: '2026-01-01T08:30:45', examinationId: 'exam-a', timePrecision: 'second'});
  Object.assign(item.points[1], {reportIssuedAt: '2026-01-01 16:20:10', examinationId: 'exam-b', timePrecision: 'second'});
  request.mockImplementation(async (path: string,init?:RequestInit) => path==='trends/snapshot/charts' ? snapshotParts([item],init) : path.startsWith('trends/snapshot?') ? snapshotOverview([item]) : []);
  const wrapper = shallowMount(TrendsPage, {global: {stubs: {RouterLink: true}}});
  try {
    await flushPromises();await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
    expect(wrapper.findAll('.trend-chart-node time').map(node => node.text())).toEqual(['2026-01-01', '2026-01-01']);
    expect(wrapper.findAll('.trend-chart-node')[0].attributes('aria-label')).toContain('08:30:45');
    expect(item.points[0].reportIssuedAt).toBe('2026-01-01T08:30:45');
  } finally { wrapper.unmount(); }
});

it('renders qualified limit values and breaks lines on both sides of limit records', async () => {
  const item = series(['2', '3', '<99.0', '4', '5', '≥100']);
  request.mockImplementation(async (path: string,init?:RequestInit) => path==='trends/snapshot/charts' ? snapshotParts([item],init) : path.startsWith('trends/snapshot?') ? snapshotOverview([item]) : []);
  const wrapper = shallowMount(TrendsPage, {global: {stubs: {RouterLink: true}}});
  try {
    await flushPromises();await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
    expect(wrapper.findAll('.trend-chart-node')).toHaveLength(6);
    expect(wrapper.findAll('.trend-chart-node.limited')).toHaveLength(2);
    expect(wrapper.findAll('.trend-sparkline polyline')).toHaveLength(2);
    const labels = wrapper.findAll('.trend-chart-value').map(node => node.text());
    expect(labels).toEqual(['2', '3', '<99.0', '4', '5', '≥100']);
    expect(wrapper.get('.trend-latest strong').text()).toContain('≥100');
    expect(wrapper.text()).toContain('限值记录，不参与精确变化计算');
    expect(wrapper.findAll('.limited i').map(node => node.attributes('data-direction'))).toEqual(['↓', '↑']);
    expect(wrapper.findAll('.limited').every(node => node.attributes('aria-label')?.includes('限值记录'))).toBe(true);
  } finally {wrapper.unmount();}
});

it.each(['<0.3', '<=0.3', '>0.3', '>=0.3'])('preserves %s even in a legacy payload without comparator metadata', async text => {
  const item = series([text]);
  delete (item.points[0] as Partial<typeof item.points[0]>).resultComparator;
  request.mockImplementation(async (path: string,init?:RequestInit) => path==='trends/snapshot/charts' ? snapshotParts([item],init) : path.startsWith('trends/snapshot?') ? snapshotOverview([item]) : []);
  const wrapper = shallowMount(TrendsPage, {global: {stubs: {RouterLink: true}}});
  try {
    await flushPromises();await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
    expect(wrapper.get('.trend-chart-value').text()).toBe(`${splitMeasurementBound(text).comparator}0.3`);
    expect(wrapper.findAll('.trend-sparkline polyline')).toHaveLength(0);
    expect(wrapper.get('.trend-chart-node').classes()).toContain('limited');
  } finally {wrapper.unmount();}
});

afterEach(()=>{vi.unstubAllGlobals();});


it('keeps the first history point within the initial chart view for dense histories', async () => {
  const item=series(Array.from({length:100},(_,i)=>String(2+i%5)));
  request.mockImplementation(async(path:string,init?:RequestInit)=>path==='trends/snapshot/charts'
    ? snapshotParts([item],init):path.startsWith('trends/snapshot?')?snapshotOverview([item]):[]);
  const wrapper=shallowMount(TrendsPage,{global:{stubs:{RouterLink:true}}});
  try{
    await flushPromises();await new Promise(resolve=>setTimeout(resolve,45));await flushPromises();
    const nodes=wrapper.findAll('.trend-chart-node');expect(nodes).toHaveLength(100);
    const canvas=wrapper.get('.trend-chart-canvas').element as HTMLElement;
    const left=Number.parseFloat((nodes[0].element as HTMLElement).style.left)/100*Number.parseFloat(canvas.style.minWidth);
    expect(left).toBeGreaterThanOrEqual(38);
    expect(left).toBeLessThan(80,'the chart must show a data point before any horizontal swipe');
  }finally{wrapper.unmount();}
});
