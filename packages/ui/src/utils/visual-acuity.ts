/*
 * 视力趋势在服务端统一为小数记录法；此处仅负责展示层换算为五分记录法
 * （L = 5 + log10(d)，保留一位小数），与服务端 visual-acuity.service.ts 对应。
 */

export type VisionScale = "decimal" | "five_point";

export function visualAcuityDecimalToFivePoint(value: number): number {
  if (value <= 0) return value;
  return Math.round((5 + Math.log10(value)) * 10) / 10;
}

export function formatVisualAcuity(value: number, scale: VisionScale): string {
  if (scale === "five_point") return visualAcuityDecimalToFivePoint(value).toFixed(1);
  // 小数记录法按视力表档位书写：整数补一位小数（1.0、2.0），其余原样（0.12、0.8）。
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
