export type AiTaskKey =
  | "report_extraction"
  | "report_summary"
  | "health_explanation"
  | "morphology_extraction"
  | "duplicate_assistance"
  | "health_process_summary";

export type AiTaskDefinition = {
  key: AiTaskKey;
  label: string;
  description: string;
  modelRole: "text" | "vision";
  responseMode: "text" | "json_object";
  implemented: boolean;
};

export const aiTaskRegistry: Record<AiTaskKey, AiTaskDefinition> = {
  health_process_summary: {
    key: 'health_process_summary',
    label: '健康历程整理',
    description: '整理已关联记录的标题、摘要、阶段与关键节点，不改变原始记录或关联',
    modelRole: 'text',
    responseMode: 'json_object',
    implemented: true
  },
  report_extraction: {
    key: "report_extraction",
    label: "报告结构化整理",
    description: "从 OCR 内容提取报告字段、指标和形态发现",
    modelRole: "text",
    responseMode: "json_object",
    implemented: true
  },
  report_summary: {
    key: "report_summary",
    label: "报告内容摘要",
    description: "面向用户整理报告重点，不参与结构化字段写入",
    modelRole: "text",
    responseMode: "json_object",
    implemented: false
  },
  health_explanation: {
    key: "health_explanation",
    label: "指标通俗解释",
    description: "解释指标用途和原报告参考信息",
    modelRole: "text",
    responseMode: "json_object",
    implemented: false
  },
  morphology_extraction: {
    key: "morphology_extraction",
    label: "形态发现整理",
    description: "整理影像、超声、内镜和病理中的形态发现",
    modelRole: "text",
    responseMode: "json_object",
    implemented: false
  },
  duplicate_assistance: {
    key: "duplicate_assistance",
    label: "重复报告辅助判断",
    description: "仅在本地规则无法确定时提供辅助候选",
    modelRole: "text",
    responseMode: "json_object",
    implemented: false
  }
};

export function aiTaskDefinition(taskKey: AiTaskKey) {
  return aiTaskRegistry[taskKey];
}

export function listAiTasks() {
  return Object.values(aiTaskRegistry);
}
