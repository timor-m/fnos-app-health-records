/** Code-shipped indicator measurement definitions. No changes to installed dictionary snapshots. */
export const measurementDimensions=['measurementSite','measurementLaterality','examinationModality','method'] as const;
export const measurementModalities=['DXA','超声心动图','CT','MRI'] as const;
export type MeasurementDimension=typeof measurementDimensions[number];
export type MeasurementIndicatorDefinition={
 dimensions:readonly MeasurementDimension[];
 /** Only existing published identities need a compatibility encoding. New indicators omit this. */
 compatibility?:'bone-v1'|'cardiac-v1'|'plain-v1';
 presentation?:'bone'|'cardiac';
 allowedSites?:readonly string[];
 defaultModality?:string;
 methodAsModality?:string;
};
export const boneMeasurementSites = [
 ['lumbar_l1','腰椎 L1'],['lumbar_l2','腰椎 L2'],['lumbar_l3','腰椎 L3'],['lumbar_l4','腰椎 L4'],
 ['lumbar_l1_l2','腰椎 L1–L2'],['lumbar_l1_l3','腰椎 L1–L3'],['lumbar_l1_l4','腰椎 L1–L4'],
 ['lumbar_l2_l3','腰椎 L2–L3'],['lumbar_l2_l4','腰椎 L2–L4'],['lumbar_l3_l4','腰椎 L3–L4'],
 ['femur_total','股骨全部'],['femur_neck','股骨颈'],['femur_neck_upper','股骨颈上部'],
 ['femur_neck_lower','股骨颈下部'],['femur_wards','Wards 三角'],['femur_trochanter','大粗隆'],['femur_shaft','股骨干'],['radius_33','桡骨远端 1/3']
] as const;
const cardiacKeys=['cardiac_lvidd','cardiac_lvids','cardiac_lvef','cardiac_lvedv','cardiac_lvesv','cardiac_aortic_sinus_diameter','cardiac_ascending_aorta_diameter','cardiac_left_atrial_diameter',
 'cardiac_aortic_diameter_unspecified','cardiac_la_diameter_unspecified','cardiac_ra_diameter_unspecified','cardiac_rv_diameter_unspecified','cardiac_ivst','cardiac_lvpw','cardiac_mpa_diameter',
 'cardiac_mitral_e_velocity','cardiac_mitral_a_velocity','cardiac_tricuspid_e_velocity','cardiac_tricuspid_a_velocity','cardiac_aortic_valve_velocity','cardiac_pulmonary_valve_velocity',
 'cardiac_mitral_annulus_septal_s_velocity','cardiac_mitral_annulus_septal_e_velocity','cardiac_mitral_annulus_septal_a_velocity'] as const;

const boneDefinition:MeasurementIndicatorDefinition={dimensions:measurementDimensions,compatibility:'bone-v1',presentation:'bone',allowedSites:boneMeasurementSites.map(([key])=>key),defaultModality:'DXA',methodAsModality:'DXA'};
const hipAxisDefinition:MeasurementIndicatorDefinition={dimensions:['examinationModality','method'],compatibility:'plain-v1',defaultModality:'DXA',methodAsModality:'DXA'};
const cardiacDefinition:MeasurementIndicatorDefinition={dimensions:['measurementSite','examinationModality','method'],compatibility:'cardiac-v1',presentation:'cardiac'};
/** Add an indicator's dimensions here; do not add a branch to trend calculation. */
export const measurementIndicatorDefinitions:Readonly<Record<string,MeasurementIndicatorDefinition>>=Object.fromEntries([
 ...['dxa_bmd','dxa_t_score','dxa_z_score'].map(key=>[key,boneDefinition]),
 ...['hip_axis_length_left','hip_axis_length_right'].map(key=>[key,hipAxisDefinition]),
 ...cardiacKeys.map(key=>[key,cardiacDefinition])
]);
export const measurementIndicatorDefinition=(key:string):MeasurementIndicatorDefinition|undefined=>measurementIndicatorDefinitions[key];
