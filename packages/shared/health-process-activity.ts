import type {HealthProcessCare} from './health-process-care';
import type {ObservationPage} from './health-observations';
import type {Reminder} from './health-reminders';
export type ActivityResult<T>={data:T;error?:never}|{error:string;data?:never};
export type HealthProcessActivity={
 processId:string;memberId:string;fingerprint:string;
 care:ActivityResult<HealthProcessCare>;observations:ActivityResult<ObservationPage>;reminders:ActivityResult<Reminder[]>;
};
