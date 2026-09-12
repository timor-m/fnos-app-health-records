import {
  VISUAL_ACUITY_CANONICAL_KEYS,
  visualAcuityToDecimal
} from "./visual-acuity.service";

/*
 * 趋势"表示法"登记表：同一物理量可能存在多种记录/计数方式（如视力的小数记录法
 * 与五分记录法）。趋势内部始终换算为 canonical 表示法（notations 第一项）存储和比较，
 * 展示层按用户选择换算；报告原始值保持不变。
 *
 * 新指标复用已有类型时只需在 SCALE_BY_CANONICAL_KEY 登记 canonicalKey，UI 无需改动；
 * 新表示法类型需提供一个换算模块并在两端各登记一次。
 */

export type ValueScaleNotation = {
  key: string;
  /** 切换控件上的短标签，如「小数」。 */
  label: string;
  /** 完整叫法，如「小数记录法」，用于单位栏与提示。 */
  title?: string;
};

const VALUE_SCALE_TYPES: Record<string, {
  notations: ValueScaleNotation[];
  toCanonical(value: number): number;
}> = {
  visual_acuity: {
    notations: [
      { key: "decimal", label: "小数", title: "小数记录法" },
      { key: "five_point", label: "五分", title: "五分记录法" }
    ],
    toCanonical: visualAcuityToDecimal
  }
};

const SCALE_BY_CANONICAL_KEY = new Map<string, string>(
  [...VISUAL_ACUITY_CANONICAL_KEYS].map((key) => [key, "visual_acuity"])
);

/** 登记了表示法的指标统一换算为 canonical 值，其余指标原样返回。 */
export function canonicalValueForScale(canonicalKey: string | null | undefined, value: number) {
  const type = canonicalKey ? SCALE_BY_CANONICAL_KEY.get(canonicalKey) : undefined;
  return type ? VALUE_SCALE_TYPES[type].toCanonical(value) : value;
}

/** 趋势序列 payload 使用：表示法类型与可选项，UI 据此通用渲染切换控件。 */
export function describeValueScale(canonicalKey: string | null | undefined) {
  const type = canonicalKey ? SCALE_BY_CANONICAL_KEY.get(canonicalKey) : undefined;
  return type ? { type, notations: VALUE_SCALE_TYPES[type].notations } : null;
}
