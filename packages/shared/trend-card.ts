import {parseBoneSeriesKey} from './bone-density';
import {measurementIndicatorDefinition} from './measurement-indicators';
import {parseMeasurementSeriesKey} from './measurement-trend-identity';

/** Presentation identity only. Source series and chart keys retain every declared dimension. */
export function trendCardKey(indicatorKey:string,unit?:string|null){
 const bone=parseBoneSeriesKey(indicatorKey);
 if(bone)return JSON.stringify(['bone',bone.group]);
 const parsed=parseMeasurementSeriesKey(indicatorKey);
 const metric=parsed?.metric || indicatorKey;
 const definition=parsed?.definition || measurementIndicatorDefinition(metric);
 if(definition && definition.presentation!=='bone'){
  const context=parsed?.context;
  return JSON.stringify(['measurement',metric,context?.measurementSite || '',context?.measurementLaterality || 'unspecified',unit || '']);
 }
 return JSON.stringify([indicatorKey,unit || '']);
}
