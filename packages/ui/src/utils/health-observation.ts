import type {HealthObservation} from '../../../shared/health-observations';
import {healthSymptomChangeLabels} from '../../../shared/health-events';
export function observationDescription(entry:HealthObservation){
 if(entry.ref.kind==='intake')return [entry.amount,entry.amountUnit].filter(Boolean).join(' ');
 return [entry.temperatureValue?'体温 '+entry.temperatureValue+' ℃':'',entry.measurementValue?[entry.measurementValue,entry.measurementUnit].filter(Boolean).join(' '):'',entry.change?healthSymptomChangeLabels[entry.change]:'',entry.severity!==null?`程度 ${entry.severity}/10`:''].filter(Boolean).join(' · ')||'补充记录';
}
