export const maxIndicatorFeedbackNames = 40;
export const maxIndicatorFeedbackLength = 3000;
export const feedbackQqGroup = "1085626763";

/** Conservative export boundary; ambiguous names stay local for review. */
export function sanitizeIndicatorFeedbackName(value: string) {
  const name = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) return null;
  if (/\b1[3-9]\d{9}\b|\b\d{17}[0-9xX]\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(name)) return null;
  if (/姓名|患者|受检者|身份证|联系电话|住址|病历号|门诊号|住院号|报告编号|医院|卫生院|体检中心|检查结果|参考范围|https?:|www\.|[|｜:：=<>≤≥↑↓]/i.test(name)) return null;
  if (/\d\s*(?:%|(?:[munpkμµ]?mol|[munpkμµ]?g|[munpk]?IU|U)\s*\/\s*[Ll]\b)/i.test(name)) return null;
  if (/\d[.,]\d+$/.test(name)) return null;
  if (/\s(?:阳性|阴性|正常|偏高|偏低|未检出|未见异常)$/.test(name)) return null;
  // Preserve name numbers such as CA 125, vitamin B12 and 25-hydroxyvitamin D.
  if (/\s[-+]?\d+(?:[.,]\d+)?$/.test(name)
    && !/(?:CA|糖[类链]抗原|癌抗原|维生素\s*[ABDEK]?|补体\s*C?|CD)\s*\d+$/i.test(name)) return null;
  return name;
}

export function validateIndicatorFeedbackNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maxIndicatorFeedbackNames) {
    throw new Error(`每次请选择 1 至 ${maxIndicatorFeedbackNames} 个指标名称`);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = typeof item === 'string' ? sanitizeIndicatorFeedbackName(item) : null;
    if (!name) throw new Error('名称疑似包含结果、个人信息或无效内容，请先在本地核对');
    const key = name.toLocaleLowerCase('zh-CN');
    if (!seen.has(key)) { names.push(name); seen.add(key); }
  }
  return names;
}

export type IndicatorFeedbackMeta = { appVersion?: string; schemaVersion?: number | string; dictionaryVersion?: string };

export function buildIndicatorFeedbackText(values: string[], meta?: IndicatorFeedbackMeta) {
  if (!values.length) return '';
  const names = validateIndicatorFeedbackNames(values);
  const lines = [`指标字典收录申请（${names.length} 项）`, '', ...names.map(name => `- ${name}`)];
  if (meta?.appVersion || meta?.schemaVersion) {
    lines.push('', `应用版本：${meta.appVersion || '?'} · 数据库：v${meta.schemaVersion || '?'}`);
  }
  if (meta?.dictionaryVersion) lines.push(`指标字典：${meta.dictionaryVersion}`);
  lines.push('', '申请名单仅含指标名称和必要版本信息；请勿添加成员、医院、报告或检查结果。系统环境由反馈页面附带。');
  const text = lines.join('\n');
  if (text.length > maxIndicatorFeedbackLength) throw new Error('申请内容超过 3000 字，请减少所选指标并分批提交');
  return text;
}
