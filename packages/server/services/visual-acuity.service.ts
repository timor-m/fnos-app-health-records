/*
 * 视力有两种常见记录方式：小数记录法（0.1–2.0）和五分记录法（4.0–5.3）。
 * 两者按 L = 5 + log10(d) 对应。趋势内部统一为小数记录法做跨报告比较，
 * 展示层再按用户选择换算回五分记录法；报告中的原始值和记录方式保持不变。
 * 「指数、手动、光感、无光感」等无法数值化的结果不进入数值趋势，不参与换算。
 */

export const VISUAL_ACUITY_CANONICAL_KEYS = new Set([
  "vision_uncorrected_right",
  "vision_uncorrected_left",
  "vision_corrected_right",
  "vision_corrected_left"
]);

export function isVisualAcuityCanonicalKey(canonicalKey: string | null | undefined) {
  return Boolean(canonicalKey && VISUAL_ACUITY_CANONICAL_KEYS.has(canonicalKey));
}

/* 标准对数视力表（GB 11533）五分记录与小数记录的官方对应档。 */
const FIVE_POINT_TO_DECIMAL = new Map([
  [4.0, 0.1],
  [4.1, 0.12],
  [4.2, 0.15],
  [4.3, 0.2],
  [4.4, 0.25],
  [4.5, 0.3],
  [4.6, 0.4],
  [4.7, 0.5],
  [4.8, 0.6],
  [4.9, 0.8],
  [5.0, 1.0],
  [5.1, 1.2],
  [5.2, 1.5],
  [5.3, 2.0]
]);

/*
 * 小数视力最大约 2.0，五分记录最小约 3.0（低视力扩展档），
 * 数值区间互不重叠，可按取值直接判断原报告使用的记录方式。
 */
export function detectVisualAcuityScale(value: number): "decimal" | "five_point" {
  return value >= 3 ? "five_point" : "decimal";
}

export function visualAcuityToDecimal(value: number): number {
  if (detectVisualAcuityScale(value) === "decimal") return value;
  const standard = FIVE_POINT_TO_DECIMAL.get(Math.round(value * 10) / 10);
  if (standard !== undefined) return standard;
  return Number(Math.pow(10, value - 5).toFixed(3));
}

export function visualAcuityToFivePoint(value: number): number {
  if (value <= 0) return value;
  return Math.round((5 + Math.log10(value)) * 10) / 10;
}
