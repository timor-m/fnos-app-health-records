/** Remove report decorations, not medical operators or qualifiers. */
export function cleanIndicatorName(value: string, options: { tableOrdinal?: boolean } = {}) {
  const decorated = value
    .normalize('NFKC')
    .replace(/^[\s*﹡★☆△¥￥"“”'‘’「」『』]+|[\s*﹡★☆△¥￥"“”'‘’「」『』]+$/g, '')
    .replace(/^(指标|项目)\s*:\s*/, '');
  /* 小结/综述页的异常枚举（"3、血清总胆固醇测定增高:5.48mmol/L(参考区间:…)"）：
     先剥序号前缀，再把名称截止到"测定增高/阳性"等判断词与冒号之前。
     没有序号前缀的行不动，避免误伤正常名称。 */
  const enumerated = /^\d+\s*[、.．]\s*/.test(decorated);
  let cleaned = decorated.replace(/^\d+\s*[、.．]\s*/, '');
  cleaned = cleaned
    .replace(/^(?:No\.?\s*\d{1,3}\s*|\(\d{1,3}\)\s*)/i, '')
    .replace(/^\d{1,3}\s*[*★☆△]+\s*/, '')
    .replace(/^[\s*★☆△]+/, '');
  // Bare row numbers need table context; numeric medical qualifiers remain intact.
  if (options.tableOrdinal && !/^\d+(?:小时|分钟|型|羟|α|β|γ|[,，-])/u.test(cleaned)) {
    cleaned = cleaned.replace(/^\d{1,3}\s*(?=[\p{Script=Han}])/u, '');
  }
  if (enumerated) {
    cleaned = cleaned
      .replace(/^(.{2,40}?)(?:测定|检查|检验)?(?:增高|升高|降低|偏高|偏低|异常|阳性|阴性|未见(?:明显)?异常)\s*[：:]\s*\S.*$/, '$1')
      .replace(/(?:测定|检查|检验)$/, '');
  }
  // OCR 把同一名称印/读两遍（"鼓膜 鼓膜"）
  cleaned = cleaned.replace(/^(.{1,15})\s+\1$/, '$1').trim();
  const suffixCode = cleaned.match(/^(.+?)\s*\[([A-Za-z][A-Za-z0-9.+%#\-/ ]{0,24})\]$/u);
  if (suffixCode && /\p{Script=Han}/u.test(suffixCode[1]) && !/^(?:Ig[AGEMD]|L|R|left|right)$/i.test(suffixCode[2])) {
    return { name: suffixCode[1].trim(), code: suffixCode[2].replace(/\s+/g, '') };
  }
  const coded = cleaned.match(/^([A-Za-z][A-Za-z0-9.+%#\-]{0,19})\s*[★☆¥￥]+\s*([\p{Script=Han}].*)$/u);
  return { name: coded ? coded[2].trim() : cleaned, code: coded ? coded[1] : null };
}
