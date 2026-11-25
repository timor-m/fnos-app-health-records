/** Invented geometry and measurements, never copied from a patient report. */
export function syntheticCardiacUltrasound(){
 const cell=(text:string,x:number,y:number)=>({id:`synthetic-${x}-${y}-${text}`,text,confidence:.99,box:[[x-20,y-8],[x+20,y-8],[x+20,y+8],[x-20,y+8]]});
 const pairs=[['主动脉',200,200,27],['左房',400,200,31],['右室常规',600,200,24],['左室舒张末',800,200,49],['左室收缩末',1000,200,33],['升主动脉',100,240,28],['右房',300,240,36],['右室',500,240,34],['主肺动脉',700,240,22],['室间隔',900,240,8],['左室后壁',1100,240,9]] as const;
 return [cell('心脏彩色超声检查',400,30),cell('心腔及大血',60,200),cell('管内径：（mm）',60,220),...pairs.flatMap(([name,x,y,value],i)=>i%2?[cell(`${name}${value}`,x,y)]:[cell(name,x,y),cell(String(value),x+65,y)]),
  cell('瓣口血流速度',70,300),cell('（m/s）',70,320),...['二尖瓣','主动脉瓣','肺动脉瓣','三尖瓣'].map((name,i)=>cell(name,220+i*200,300)),
  cell('E',200,340),cell('0.71',300,340),cell('A',200,380),cell('0.41',300,380),cell('1.31',480,340),cell('0.81',680,340),cell('E',800,340),cell('0.51',880,340),cell('A',800,380),
  cell('峰值压差',420,380),cell('峰值压差',620,380),cell('PHT',200,420),cell('LVEF',970,400),cell('67%',1050,400),
  cell('超声描述',60,500),cell('合成描述，仅供软件验证。',400,500),cell('组织多普勒二尖瓣环室间隔组织速度 S′11cm/s，E′14cm/s，A′10cm/s；',600,600)];
}
