// Process-local read-only scheduling snapshot. Importing this module never starts work.
export type MaintenanceState = {
  firstAt: number | null;
  periodicAt: number | null;
  intervalMs: number;
  ready: boolean;
  running: boolean;
  lastGcAt: number | null;
  failure: boolean;
};
let state: MaintenanceState = {firstAt:null,periodicAt:null,intervalMs:0,ready:false,running:false,lastGcAt:null,failure:false};
export function getMaintenanceState(): MaintenanceState { return {...state}; }
export function scheduleMaintenance(now:number, firstDelay:number, interval:number) {
  state={firstAt:now+firstDelay,periodicAt:now+interval,intervalMs:interval,ready:true,running:false,lastGcAt:null,failure:false};
}
export function maintenanceTick(first:boolean) {
  if(first) state.firstAt=null;
  else if(state.periodicAt!==null) state.periodicAt+=state.intervalMs;
}
export function maintenanceRunning(running:boolean) { state.running=running; }
export function maintenanceGcFinished(now:number) { state.lastGcAt=now; state.failure=false; }
export function maintenanceFailed() { state.failure=true; }

export function cleanupSchedule(state:MaintenanceState, earliest:number|null, now:number, pause:string|null) {
  if(pause) return {status:'paused' as const,at:null,reason:pause};
  if(state.failure && (!state.ready || earliest===null || !Number.isFinite(earliest) || state.running)) return {status:'delayed' as const,at:null,reason:'MAINTENANCE_FAILED'};
  if(!state.ready || earliest===null || !Number.isFinite(earliest)) return {status:'unknown' as const,at:null,reason:'SCHEDULE_UNKNOWN'};
  const due=[state.firstAt,state.periodicAt].filter((value):value is number=>value!==null);
  if(due.some(value=>value<now)) return {status:'delayed' as const,at:null,reason:'SCHEDULE_OVERDUE'};
  if(state.running) return {status:'unknown' as const,at:null,reason:'MAINTENANCE_RUNNING'};
  const candidates:number[]=[];
  if(state.firstAt!==null && state.firstAt>=earliest) candidates.push(state.firstAt);
  if(state.periodicAt!==null && state.intervalMs>0) candidates.push(state.periodicAt+Math.max(0,Math.ceil((earliest-state.periodicAt)/state.intervalMs))*state.intervalMs);
  const at=candidates.length?new Date(Math.min(...candidates)).toISOString():null;
  if(state.failure) return {status:'delayed' as const,at,reason:'MAINTENANCE_FAILED'};
  return {status:at?'waiting' as const:'unknown' as const,at,reason:at?null:'SCHEDULE_UNKNOWN'};
}
