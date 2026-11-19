// Common entry values only. Keep the original string for imported or custom values;
// these suggestions never infer a dosage, normalize units or select a default.
function options(values: string[]) { return values.map(value => ({ value, label: value })); }

export const medicationFrequencyOptions = options([
  '每日一次', '每日两次', '每日三次', '每日四次', '每晚一次',
  '每8小时一次', '每12小时一次', '每周一次', '必要时',
]);
export const medicationUnitOptions = options([
  '片', '粒', '袋', '丸', '滴', '喷', '揿', '支', '贴', '枚', 'mL', 'mg', 'g', 'μg', '单位',
]);
export const medicationQuantityUnitOptions = options(['盒', '瓶', '袋', '支', '板', '片', '粒', '贴']);
export const medicationDosageFormOptions = options([
  '片剂', '胶囊剂', '颗粒剂', '口服溶液', '混悬液', '滴剂', '喷雾剂', '软膏剂', '乳膏剂', '贴剂', '注射剂', '栓剂',
]);
export const medicationRouteOptions = options([
  '口服', '外用', '吸入', '滴眼', '滴鼻', '滴耳', '舌下含服', '皮下注射', '肌内注射', '静脉注射', '静脉滴注',
]);
export const symptomFrequencyOptions = options(['首次出现', '偶尔', '间歇性', '反复发作', '每天', '持续']);
export const measurementUnitOptions = options(['℃', '次/分', '%', 'mmHg', 'kg', 'cm', 'mmol/L', 'mg/dL', 'mL']);
