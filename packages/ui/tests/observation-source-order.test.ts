import {expect,it} from 'vitest';
import {observationSourceSections} from '../src/utils/observation-source-order';
import type {Observation,OcrPageDetail,ReportPage} from '../src/types/api';
const page=(id:string,pageNumber:number)=>({id,pageNumber} as ReportPage);
const item=(id:string,pageId='p1')=>({id,evidence:{pageId,lineIds:[id]}} as Observation);
const ocr=(boxes:Record<string,number[]>,extra={})=>({lines:Object.entries(boxes).map(([id,box])=>({id,box})),...extra} as OcrPageDetail);
const ids=(sections:ReturnType<typeof observationSourceSections>)=>sections.flatMap(section=>section.items.map(item=>item.id));
it('orders independent columns down the left then down the right, across pages, with unlocated items last',()=>{
 const observations=['r2','l2','r1','l1','unknown'].map(id=>item(id));
 observations.unshift(item('next','p2')); observations.push(item('unpaged','gone'));
 const sections=observationSourceSections(observations,[page('p1',1),page('p2',2)],{p1:ocr({l1:[10,10,200,20],l2:[10,40,200,50],r1:[400,10,600,20],r2:[400,40,600,50]})});
 expect(ids(sections)).toEqual(['l1','l2','r1','r2','unknown','next','unpaged']);
 expect(sections[0].unpositionedIds.has('unknown')).toBe(true);
 expect(sections[2].title).toBe('来源页待确认');
});
it('handles a full width section followed by independent tables and retains duplicate indicators',()=>{
 const observations=['b','c','title','a','d'].map(id=>item(id));
 const sections=observationSourceSections(observations,[page('p1',1)],{p1:ocr({title:[10,0,600,10],a:[10,60,220,70],b:[10,80,220,90],c:[400,60,600,70],d:[400,80,600,90]})});
 expect(ids(sections)).toEqual(['title','a','b','c','d']);
});
it('keeps OCR reading order independent of rotated display coordinates and CSS image scaling',()=>{
 const data=ocr({a:[80,10,90,20],b:[40,10,50,20]});
 data.lines[0].readingBox=[10,10,20,20];data.lines[1].readingBox=[10,50,20,60];
 expect(ids(observationSourceSections([item('b'),item('a')],[page('p1',1)],{p1:data}))).toEqual(['a','b']);
});
it('fails conservatively for stale, missing or invalid coordinates and follows current page order',()=>{
 const sections=observationSourceSections([item('b','p2'),item('a')],[page('p2',1),page('p1',2)],{p1:ocr({a:[10,10,0,0]}),p2:ocr({b:[1,1,5,5]},{orientationChanged:true})});
 expect(ids(sections)).toEqual(['b','a']);
 expect(sections.every(section=>section.unpositionedIds.size===1)).toBe(true);
});
it('inserts a manually located row between OCR rows in the same normalized reading space',()=>{
 const manual={...item('manual'),evidence:{...item('manual').evidence!,lineIds:[],readingRegion:[.05,.3,.4,.35] as [number,number,number,number]}};
 const data=ocr({a:[50,100,400,150],b:[50,500,400,550],r:[600,100,900,150]},{coordWidth:1000,coordHeight:1000});
 expect(ids(observationSourceSections([item('r'),item('b'),manual,item('a')],[page('p1',1)],{p1:data}))).toEqual(['a','manual','b','r']);
});
it('does not compare pixel OCR positions with normalized regions when the historic image scale is unknown',()=>{
 const manual={...item('manual'),evidence:{...item('manual').evidence!,lineIds:[],readingRegion:[.1,.8,.5,.9] as [number,number,number,number]}};
 const sections=observationSourceSections([item('a'),manual],[page('p1',1)],{p1:ocr({a:[10,20,200,30]})});
 expect(sections[0].unpositionedIds.has('a')).toBe(true);
 expect(sections[0].unpositionedIds.has('manual')).toBe(false);
});
