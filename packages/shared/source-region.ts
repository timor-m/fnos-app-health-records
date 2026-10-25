/** Normalized rectangle in an immutable report page's image coordinate space. */
export type SourceRegion = { box: [number,number,number,number]; rotation: number };
export function sourceRegion(value: unknown): SourceRegion | null {
  if (!value || typeof value !== 'object') return null;
  const {box,rotation} = value as SourceRegion;
  if (!Array.isArray(box) || box.length!==4 || !box.every(n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=1)
    || box[2]-box[0]<.001 || box[3]-box[1]<.001 || ![0,90,180,270].includes(rotation)) return null;
  return {box:[...box],rotation};
}
export function rotateRegionBox(box: SourceRegion['box'], angle: number): SourceRegion['box'] {
  const [l,t,r,b]=box;
  switch ((angle%360+360)%360) {
    case 90:return [1-b,l,1-t,r];
    case 180:return [1-r,1-b,1-l,1-t];
    case 270:return [t,1-r,b,1-l];
    default:return [...box];
  }
}
export function unrotateRegionPoint(x:number,y:number,angle:number):[number,number] {
  switch((angle%360+360)%360){case 90:return[y,1-x];case 180:return[1-x,1-y];case 270:return[1-y,x];default:return[x,y];}
}
