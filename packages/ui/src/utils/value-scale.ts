/*
 * 趋势表示法的展示层处理：序列 valueScale（见服务端 value-scale.service.ts）声明了
 * 类型与可选表示法，这里按类型提供换算、格式化和差值精度。趋势页不感知具体类型。
 */

import type { TrendValueScale } from "../types/api";
import { formatVisualAcuity, visualAcuityDecimalToFivePoint, type VisionScale } from "./visual-acuity";

type ScaleDisplayHandler = {
  /** canonical 值换算为指定表示法的展示值。 */
  convert(value: number, notation: string): number;
  format(value: number, notation: string): string;
  /** 展示差值的小数精度；null 表示走通用数字格式化。 */
  deltaPrecision(notation: string): number | null;
};

const SCALE_DISPLAY_HANDLERS: Record<string, ScaleDisplayHandler> = {
  visual_acuity: {
    convert: (value, notation) =>
      notation === "five_point" ? visualAcuityDecimalToFivePoint(value) : value,
    format: (value, notation) => formatVisualAcuity(value, notation as VisionScale),
    deltaPrecision: (notation) => (notation === "five_point" ? 1 : null)
  }
};

/** notations 第一项为 canonical（内部统一口径）。 */
export function canonicalNotation(scale: TrendValueScale) {
  return scale.notations[0]?.key || "";
}

export function notationTitle(scale: TrendValueScale, notation: string) {
  const item = scale.notations.find((entry) => entry.key === notation);
  return item?.title || item?.label || notation;
}

export function convertScaledValue(scale: TrendValueScale, value: number, notation: string) {
  const handler = SCALE_DISPLAY_HANDLERS[scale.type];
  return handler ? handler.convert(value, notation) : value;
}

export function formatScaledValue(scale: TrendValueScale, value: number, notation: string) {
  const handler = SCALE_DISPLAY_HANDLERS[scale.type];
  return handler ? handler.format(value, notation) : String(value);
}

export function scaledDeltaPrecision(scale: TrendValueScale, notation: string) {
  return SCALE_DISPLAY_HANDLERS[scale.type]?.deltaPrecision(notation) ?? null;
}
