/** Only actionable data-quality notices belong behind the attention icon. */
export function observationAttentionHint(input: {
  displayTier: string; displayCategory: string; displayReason: string | null;
  normalizationExcludedReason: string | null; abnormalConflict: boolean;
  abnormalStatus: string; abnormalReason: string | null;
  referenceStatus: string; referenceReason: string | null;
}) {
  const reasons: Array<string | null> = [];
  if (input.displayTier !== 'primary' && input.displayCategory !== 'qualitative_finding') {
    reasons.push(input.displayReason || input.normalizationExcludedReason || '指标仍需核对');
  }
  if (input.abnormalConflict || input.abnormalStatus === 'conflict') {
    reasons.push(input.abnormalReason || '报告异常标记与数值或参考范围不一致，请核对');
  }
  if (input.referenceStatus === 'raw_only') reasons.push(input.referenceReason || '参考范围尚未核实，仅保留原文');
  return [...new Set(reasons.map(reason => reason?.trim()).filter(Boolean))].join('\n');
}

export type ObservationAbnormalDisplayInput = {
  displayAbnormalFlag: "high" | "low" | "abnormal" | "normal" | null;
  abnormalStatus: "reported" | "computed" | "conflict" | "unresolved";
  abnormalConflict: boolean;
  abnormalReason?: string | null;
};

export type ObservationAbnormalDisplay = {
  visible: boolean;
  label: string;
  explanation: string | null;
  tone: "high" | "low" | "abnormal" | "normal" | "review" | "plain";
  isAbnormal: boolean;
  isConflict: boolean;
  isComputed: boolean;
};

/** 报告详情与趋势页共用的异常展示语义，避免同一治理状态在不同页面出现不同文案。 */
export function describeObservationAbnormal(
  input: ObservationAbnormalDisplayInput,
): ObservationAbnormalDisplay {
  if (input.abnormalConflict || input.abnormalStatus === "conflict") {
    return {
      visible: true,
      label: "异常标记待核验",
      explanation: input.abnormalReason || "报告异常标记与数值或参考范围不一致，已暂停自动判定",
      tone: "review",
      isAbnormal: false,
      isConflict: true,
      isComputed: false,
    };
  }

  const flag = input.displayAbnormalFlag;
  const isComputed = input.abnormalStatus === "computed";
  const label = isComputed && flag === "high"
    ? "高于参考范围"
    : isComputed && flag === "low"
      ? "低于参考范围"
      : flag === "high"
        ? "偏高"
        : flag === "low"
          ? "偏低"
          : flag === "abnormal"
            ? "异常"
            : flag === "normal" ? "正常" : "";
  const tone = flag === "high"
    ? "high"
    : flag === "low"
      ? "low"
      : flag === "abnormal"
        ? "abnormal"
        : flag === "normal" ? "normal" : "plain";
  return {
    visible: Boolean(flag),
    label,
    explanation: isComputed ? input.abnormalReason || null : null,
    tone,
    isAbnormal: flag === "high" || flag === "low" || flag === "abnormal",
    isConflict: false,
    isComputed,
  };
}

export function formatRawIndicatorResult(
  resultText: string | null | undefined,
  unit: string | null | undefined,
  emptyLabel = ""
) {
  const result = (resultText || "").trim();
  const normalizedUnit = (unit || "").trim();
  if (!result) return normalizedUnit || emptyLabel;
  if (!normalizedUnit || result.toLowerCase().endsWith(normalizedUnit.toLowerCase())) return result;
  return `${result} ${normalizedUnit}`;
}

export function formatObservationNormalization(input: {
  canonicalName: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  normalizationQuality: "high" | "medium" | "low" | "excluded" | null;
  normalizationExcludedReason: string | null;
}) {
  if (!input.canonicalName) return "";
  const quality = {
    high: "高可信",
    medium: "中可信",
    low: "低可信",
    excluded: "已识别"
  }[String(input.normalizationQuality)] || "已识别";
  const hasCanonicalValue = input.canonicalValue !== null && input.canonicalValue !== undefined;
  const value = hasCanonicalValue
    ? ` · 趋势值 ${input.canonicalValue}${input.canonicalUnit ? ` ${input.canonicalUnit}` : ""}`
    : "";
  const withheldReason = !hasCanonicalValue && ["low", "excluded"].includes(String(input.normalizationQuality))
    ? ` · 未生成趋势值，保留原始结果${input.normalizationExcludedReason ? `（${input.normalizationExcludedReason}）` : ""}`
    : "";
  return `已整理为：${input.canonicalName} · ${quality}${value}${withheldReason}`;
}

export function formatReferenceRange(input: {
  referenceLow: number | null;
  referenceHigh: number | null;
  referenceText: string | null;
  unit?: string | null;
  formatNumber?: (value: number) => string;
}, emptyLabel = "参考范围待整理") {
  const text = (input.referenceText || "").trim();
  if (text) return `参考 ${text}`;
  const unit = (input.unit || "").trim();
  const suffix = unit ? ` ${unit}` : "";
  const format = input.formatNumber || ((value: number) => String(value));
  if (input.referenceLow !== null && input.referenceHigh !== null) {
    return `参考 ${format(input.referenceLow)} - ${format(input.referenceHigh)}${suffix}`;
  }
  if (input.referenceHigh !== null) return `参考 ≤ ${format(input.referenceHigh)}${suffix}`;
  if (input.referenceLow !== null) return `参考 ≥ ${format(input.referenceLow)}${suffix}`;
  return emptyLabel;
}
