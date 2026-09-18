/* 诊断原因码与任务/单元错误码统一在这里中文化；
   未收录的新码原样展示，保留排查线索。 */
const processingCodeLabels: Record<string, string> = {
  OCR_RUNTIME_UNAVAILABLE: "OCR 服务不可用",
  OCR_FAILED: "OCR 识别失败",
  OCR_EMPTY: "OCR 未识别到文字",
  OCR_LOW_QUALITY: "OCR 质量偏低",
  AI_CALL_FAILED: "AI 调用失败",
  AI_INVALID_OUTPUT: "AI 输出格式异常",
  AI_TRUNCATED_OUTPUT: "AI 输出被截断",
  AI_PARTIAL_RESULT: "部分结果被证据校验拒绝",
  TABLE_STRUCTURE_UNRELIABLE: "表格结构识别不完整",
  SUPPLEMENT_REQUIRED: "已追加遗漏补提取",
  SUPPLEMENT_UNRESOLVED: "补提取后仍有未核对项",
  POSTPROCESS_REDUNDANT: "重复结果已剔除",
  POSTPROCESS_IGNORED: "无效结果已忽略",
  POSTPROCESS_UNVERIFIED: "未验证结果已拦截",
  AI_UNMATCHED_CANDIDATES: "候选未全部核对",
  LEASE_EXPIRED: "任务执行超时",
  AI_ERROR: "AI 调用错误",
  AI_EMPTY_RESPONSE: "AI 无响应内容",
  AI_EMPTY_RESULT: "AI 未产出结果",
  AI_INVALID_JSON: "AI 输出格式异常",
  AI_NOT_CONFIGURED: "AI 服务未配置",
  AI_OUTPUT_TRUNCATED: "AI 输出被截断",
  AI_TASK_CANCELLED: "任务已取消",
  AI_TASK_NOT_IMPLEMENTED: "任务类型不支持",
  EMPTY_REPORT_PAGES: "报告无可用页面",
  EMPTY_REPORT_TEXT: "报告无可用文字",
  INVALID_PDF_PAGE_COUNT: "PDF 页数异常",
  INVALID_STORAGE_PATH: "存储路径异常",
  OCR_PAGE_SET_INCOMPLETE: "OCR 页面不完整",
  PDF_INSPECTION_INCOMPLETE: "PDF 检查未完成",
  PDF_PAGE_COUNT_MISMATCH: "PDF 页数不一致",
  PDF_PAGE_EXPANSION_INCOMPLETE: "PDF 拆页未完成",
  PDF_PAGE_SET_INCOMPLETE: "PDF 页面不完整",
  REPORT_PAGE_SEQUENCE_INVALID: "报告页序异常"
};

export function processingCodeLabel(code: string) {
  return processingCodeLabels[code] || code;
}
