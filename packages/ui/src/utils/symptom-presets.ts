// Entry suggestions, not diagnoses or a clinical decision tree. Regions overlap on
// purpose: the user chooses what they experienced; no cause or severity is inferred.
// Vocabulary cross-checked against https://www.nhs.uk/symptoms/ .
export const symptomAreas = [
  { id: 'general', label: '全身／不确定', value: '', symptoms: ['发热','乏力','畏寒','出汗多','盗汗','食欲下降','体重下降','体重增加','全身酸痛','口渴','嗜睡','睡眠不佳'] },
  { id: 'head', label: '头部', value: '头部', symptoms: ['头痛','头晕','头部胀痛','头皮疼痛','头皮瘙痒','脱发','记忆力下降','注意力不集中'] },
  { id: 'nose', label: '鼻部', value: '鼻部', symptoms: ['流鼻涕','鼻塞','打喷嚏','鼻痒','鼻出血','鼻部疼痛','鼻腔干燥','嗅觉减退'] },
  { id: 'throat', label: '咽喉', value: '咽喉', symptoms: ['咽痛','咽干','咽痒','咳嗽','咳痰','声音嘶哑','吞咽困难','咽部异物感'] },
  { id: 'chest', label: '胸部', value: '胸部', symptoms: ['胸痛','胸闷','心慌','气短','呼吸困难','喘息','咳嗽','咳痰','咳血','乳房疼痛','乳房肿块','乳头溢液'] },
  { id: 'abdomen', label: '腹部', value: '腹部', symptoms: ['腹痛','腹胀','恶心','呕吐','腹泻','便秘','反酸','烧心','嗳气','食欲下降','排气增多'] },
  { id: 'skin', label: '皮肤', value: '皮肤', symptoms: ['皮疹','瘙痒','皮肤发红','皮肤干燥','脱皮','水疱','皮肤肿胀','皮下肿块','淤青','皮肤疼痛','伤口渗液','指甲变化'] },
  { id: 'eyes', label: '眼部', value: '眼部', symptoms: ['眼痛','眼痒','眼红','眼干','流泪','眼部分泌物增多','视物模糊','畏光','眼前黑影','眼皮跳','眼睑肿胀','重影'] },
  { id: 'ears', label: '耳部', value: '耳部', symptoms: ['耳痛','耳鸣','耳闷','耳痒','听力下降','耳部分泌物'] },
  { id: 'mouth', label: '口腔／牙齿', value: '口腔／牙齿', symptoms: ['牙痛','牙龈出血','牙龈肿痛','口腔溃疡','口干','口苦','口臭','舌痛','口唇干裂','味觉改变','下颌疼痛'] },
  { id: 'neck', label: '颈肩', value: '颈肩', symptoms: ['颈部疼痛','颈部僵硬','颈部肿块','肩痛','肩部僵硬','肩部活动受限'] },
  { id: 'back', label: '腰背', value: '腰背', symptoms: ['腰痛','背痛','腰背僵硬','腰背酸胀','尾骨疼痛','腰背活动受限'] },
  { id: 'arms', label: '上肢／手', value: '上肢／手', symptoms: ['上臂疼痛','肘痛','前臂疼痛','腕痛','手指疼痛','上肢麻木','手抖','手部肿胀','握力下降','关节僵硬','活动受限'] },
  { id: 'legs', label: '下肢／足', value: '下肢／足', symptoms: ['髋部疼痛','大腿疼痛','膝痛','小腿疼痛','踝痛','足痛','足跟痛','下肢麻木','腿抽筋','下肢肿胀','行走困难','关节僵硬'] },
  { id: 'urinary', label: '泌尿部位', value: '泌尿部位', symptoms: ['尿频','尿急','尿痛','排尿困难','尿不尽感','尿失禁','尿液带血','尿液浑浊','尿量减少','夜尿增多'] },
  { id: 'reproductive', label: '生殖部位', value: '生殖部位', symptoms: ['外阴瘙痒','外阴疼痛','分泌物异常','月经不规律','经量增多','非经期出血','痛经','阴囊疼痛','阴囊肿胀','阴茎疼痛','生殖部位皮疹'] },
  { id: 'anus', label: '肛门／直肠', value: '肛门／直肠', symptoms: ['肛门疼痛','肛门瘙痒','便血','排便疼痛','肛门肿物','肛门坠胀','大便失禁'] },
  { id: 'sleep', label: '睡眠／情绪', value: '', symptoms: ['入睡困难','易醒','早醒','多梦','嗜睡','打鼾','情绪低落','紧张不安','烦躁','兴趣减退'] },
  { id: 'other', label: '其他部位', value: '', symptoms: ['疼痛','麻木','肿胀','瘙痒','僵硬','酸胀','活动受限'] },
] as const;
export type SymptomAreaId = typeof symptomAreas[number]['id'];
const detailedAreas: Partial<Record<SymptomAreaId, string[]>> = {
  head:['额部','头顶部','枕部','左侧头部','右侧头部','太阳穴'],
  nose:['左侧鼻部','右侧鼻部','双侧鼻部'], throat:['咽部','喉部'],
  chest:['左侧胸部','右侧胸部','胸骨后','左侧乳房','右侧乳房'],
  abdomen:['上腹部','下腹部','左上腹','右上腹','左下腹','右下腹','脐周'],
  skin:['面部皮肤','头皮','躯干皮肤','上肢皮肤','下肢皮肤','全身皮肤'],
  eyes:['左眼','右眼','双眼'], ears:['左耳','右耳','双耳'],
  mouth:['牙齿','牙龈','舌部','口唇','口腔黏膜','下颌'],
  neck:['颈部','左肩','右肩','双肩'],back:['上背部','下背部','左侧腰部','右侧腰部','尾骨部'],
  arms:['左上臂','右上臂','左肘','右肘','左前臂','右前臂','左腕','右腕','左手','右手','手指'],
  legs:['左髋','右髋','左大腿','右大腿','左膝','右膝','左小腿','右小腿','左踝','右踝','左足','右足','足跟'],
  urinary:['尿道口','下腹部'],reproductive:['外阴','阴道','阴茎','阴囊'],anus:['肛门','肛周'],
};
export function symptomBodyAreaOptions(id:SymptomAreaId){
 const area=symptomAreas.find(area=>area.id===id)!;
 return [...new Set([area.value,...(detailedAreas[id]||[])].filter(Boolean))].map(value=>({value,label:value}));
}
export const symptomTriggerOptions = ['无明显诱因','活动后','运动后','劳累后','进食后','空腹时','受凉后','接触刺激物后','情绪紧张时','久坐后','久站后','体位改变时','夜间出现'].map(value=>({value,label:value}));
export const symptomReliefOptions = ['尚未尝试','无明显缓解','休息后缓解','停止活动后缓解','改变体位后缓解','进食后缓解','排便后缓解','热敷后缓解','冷敷后缓解','用药后缓解'].map(value=>({value,label:value}));
export const associatedSymptomChoices = ['发热','乏力','头痛','头晕','咳嗽','咽痛','恶心','呕吐','腹泻','皮疹'];
export function toggleAssociatedSymptom(text:string,name:string){
 const values=text.split(/[、,，;；\n]+/).map(value=>value.trim()).filter(Boolean);
 return (values.includes(name)?values.filter(value=>value!==name):[...values,name]).join('、');
}
export function localSymptomDate(daysAgo=0){const date=new Date();date.setDate(date.getDate()-daysAgo);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
