/** Remove report decorations, not medical operators or qualifiers. */
export function cleanIndicatorName(value: string) {
  const name = value.normalize('NFKC').replace(/^[\s*﹡★☆¥￥]+|[\s*﹡★☆¥￥]+$/g, '');
  const coded = name.match(/^([A-Za-z][A-Za-z0-9.+%#\-]{0,19})\s*[★☆¥￥]+\s*([\p{Script=Han}].*)$/u);
  return { name: coded ? coded[2].trim() : name, code: coded ? coded[1] : null };
}
