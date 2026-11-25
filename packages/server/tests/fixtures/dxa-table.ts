/** Synthetic geometry and values; contains no patient report data. */
export function syntheticDxaPage(hip=false) {
 const cell=(text:string,x:number,y:number)=>({id:`${x}-${y}-${text}`,text,confidence:.99,box:[[x-30,y-10],[x+30,y-10],[x+30,y+10],[x-30,y+10]],tableUnsafe:true});
 const rows=hip?['颈','全部']:['腰椎1','腰椎2','L1-L4'];
 const lines=[cell('Lunar iDXA',700,500),cell('T-值评分：美国，Z-值评分：中国',300,60),cell(hip?'左侧股骨：全部':'正位脊柱：L1-L4',300,30),cell('区域',80,120),cell('(g/cm2)',240,120),cell('T值',360,120),cell('Z值',480,120),...rows.flatMap((name,i)=>[cell(name,80,150+i*24),cell(String(.6+i*.1),240,150+i*24),cell(String(-1-i*.1),360,150+i*24),cell(String(i*.1),480,150+i*24)]),cell(hip?'骨密度仪趋势：全部':'骨密度仪趋势：L1-L4',300,230),cell('骨密度',240,260),cell('测量日期',80,280),cell('05/18/2024',80,310),cell(String(.6+(rows.length-1)*.1),240,310),cell('05/18/2023',80,334),cell('0.5',240,334)];
 return lines;
}

export function syntheticDxaPageWithAxis(side:'left'|'right'|'both'='left') {
 const lines=syntheticDxaPage(true).map(line=>({...line,text:side==='right'?line.text.replaceAll('左','右'):line.text,box:line.box.map(([x,y])=>[x+500,y])}));
 const cell=(text:string,y:number)=>({id:`axis-${y}`,text,confidence:.99,box:[[160,y-10],[240,y-10],[240,y+10],[160,y+10]],tableUnsafe:true});
 return [...lines,cell('髋关节中轴长度比较（mm）',60),cell(side==='right'?'右侧3.4':'左侧3.4',90),cell(side==='both'?'左=112.4mm 右=118.6mm 均值=109.0mm':side==='right'?'右=118.6mm 均值=109.0mm':'左=112.4mm 均值=109.0mm',175)];
}

/** All seven femoral regions on one explicitly sided table. */
export function syntheticFullFemurPage(side:'left'|'right',offset=0) {
 const cell=(text:string,x:number,y:number)=>({id:`${side}-${x}-${y}`,text,confidence:.99,box:[[x-30,y-10],[x+30,y-10],[x+30,y+10],[x-30,y+10]],tableUnsafe:true});
 const labels=['颈','股骨颈上部','股骨颈下半部','Wards三角','大粗隆','股骨干','全部'];
 const bmd=(i:number)=>(.6+i*.02+offset).toFixed(2);
 return [cell('Lunar iDXA',700,500),cell('T-值评分：美国，Z-值评分：中国',300,60),cell(`${side==='left'?'左':'右'}侧股骨：全部`,300,30),
  cell('区域',80,120),cell('(g/cm2)',240,120),cell('T值',360,120),cell('Z值',480,120),
  ...labels.flatMap((name,i)=>[cell(name,80,150+i*24),cell(bmd(i),240,150+i*24),cell((-1-i*.2-offset).toFixed(2),360,150+i*24),cell((i*.1+offset).toFixed(2),480,150+i*24)]),
  cell('骨密度仪趋势：全部',300,370),cell('骨密度',240,400),cell('测量日期',80,420),cell('05/18/2024',80,450),cell(bmd(6),240,450),cell('05/18/2023',80,474),cell((.5+offset).toFixed(2),240,474)];
}
