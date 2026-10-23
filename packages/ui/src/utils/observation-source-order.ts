import type { Observation, OcrPageDetail, ReportPage } from '../types/api';

type Positioned = { item: Observation; box: [number, number, number, number] };

// Split independent columns at empty gutters; keep each column top-to-bottom.
// Horizontal cuts allow full-width sections above or below independent tables.
function readingOrder(items: Positioned[]): Positioned[] {
  if (items.length < 2) return items;
  const heights = items.map(({box}) => box[3] - box[1]).sort((a,b) => a-b);
  const height = heights[Math.floor(heights.length/2)];
  const byX = [...items].sort((a,b) => a.box[0]-b.box[0]);
  let right = byX[0].box[2];
  for (let i=1;i<byX.length;i++) {
    if (byX[i].box[0]-right > height*1.5) {
      return [...readingOrder(byX.slice(0,i)), ...readingOrder(byX.slice(i))];
    }
    right = Math.max(right,byX[i].box[2]);
  }
  const byY = [...items].sort((a,b) => a.box[1]-b.box[1] || a.box[0]-b.box[0]);
  let bottom = byY[0].box[3];
  for (let i=1;i<byY.length;i++) {
    if (byY[i].box[1]-bottom > height*1.5) {
      return [...readingOrder(byY.slice(0,i)), ...readingOrder(byY.slice(i))];
    }
    bottom = Math.max(bottom,byY[i].box[3]);
  }
  // Group overlapping cells into rows rather than using a non-transitive comparator.
  const rows: Positioned[][] = [];
  for (const item of byY) {
    const row = rows.at(-1);
    const anchor = row?.[0].box;
    if (anchor && Math.min(anchor[3],item.box[3])-Math.max(anchor[1],item.box[1]) > Math.min(anchor[3]-anchor[1],item.box[3]-item.box[1])*.4) row!.push(item);
    else rows.push([item]);
  }
  return rows.flatMap(row => row.sort((a,b) => a.box[0]-b.box[0]));
}

export function observationSourceSections(observations: Observation[], pages: ReportPage[], ocrPages: Record<string,OcrPageDetail>) {
  const sections = pages.map(page => {
    const items = observations.filter(item => item.evidence?.pageId === page.id);
    const ocr = ocrPages[page.id];
    const positioned: Positioned[] = [];
    const unknown: Observation[] = [];
    for (const item of items) {
      if (item.evidence?.readingRegion) {
        positioned.push({item,box:[...item.evidence.readingRegion]});
        continue;
      }
      const lines = ocr && !ocr.orientationChanged
        ? ocr.lines.filter(line => item.evidence!.lineIds.includes(line.id)) : [];
      const coordWidth=ocr?.readingCoordWidth || ocr?.coordWidth || page.width;
      const coordHeight=ocr?.readingCoordHeight || ocr?.coordHeight || page.height;
      // Pixel OCR and normalized manual boxes cannot be compared without a scale.
      if ((!coordWidth || !coordHeight) && items.some(candidate=>candidate.evidence?.readingRegion)) { unknown.push(item); continue; }
      const width=coordWidth || 1;
      const height=coordHeight || 1;
      const boxes = lines.map(line => line.readingBox ?? line.box).filter((box): box is number[] => Boolean(box && box.length===4 && box.every(Number.isFinite) && box[2]>box[0] && box[3]>box[1]));
      const normalizedBoxes=boxes.map(box=>[box[0]/width,box[1]/height,box[2]/width,box[3]/height]);
      if (!normalizedBoxes.length) { unknown.push(item); continue; }
      positioned.push({item,box:[Math.min(...normalizedBoxes.map(b=>b[0])),Math.min(...normalizedBoxes.map(b=>b[1])),Math.max(...normalizedBoxes.map(b=>b[2])),Math.max(...normalizedBoxes.map(b=>b[3]))]});
    }
    return {key:page.id,title:`第 ${page.pageNumber} 页`,description:`${items.length} 项${unknown.length ? ` · ${unknown.length} 项位置待确认` : ''}`,items:readingOrder(positioned).map(entry=>entry.item).concat(unknown),unpositionedIds:new Set(unknown.map(item=>item.id))};
  });
  const unpaged = observations.filter(item => !pages.some(page => page.id===item.evidence?.pageId));
  if (unpaged.length) sections.push({key:'unpaged',title:'来源页待确认',description:`${unpaged.length} 项`,items:unpaged,unpositionedIds:new Set(unpaged.map(item=>item.id))});
  return sections;
}
