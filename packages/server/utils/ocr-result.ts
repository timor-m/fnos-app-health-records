/** Only unambiguous character cleanup: never transpose digits or infer a decimal. */
export function cleanOcrResult(value: string) {
  return value.normalize('NFKC').trim().replace(/(?<=\d)\s*\.\s*(?=\d)/g, '.');
}
