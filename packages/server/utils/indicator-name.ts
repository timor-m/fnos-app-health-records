/** Remove report decorations, not medical operators or qualifiers. */
export function cleanIndicatorName(value: string) {
  const cleaned = value
    .normalize('NFKC')
    .replace(/^[\s*﹡★☆¥￥"“”'‘’「」『』]+|[\s*﹡★☆¥￥"“”'‘’「」『』]+$/g, '')
    .replace(/^(指标|项目)\s*:\s*/, '');
  const coded = cleaned.match(/^([A-Za-z][A-Za-z0-9.+%#\-]{0,19})\s*[★☆¥￥]+\s*([\p{Script=Han}].*)$/u);
  return { name: coded ? coded[2].trim() : cleaned, code: coded ? coded[1] : null };
}
