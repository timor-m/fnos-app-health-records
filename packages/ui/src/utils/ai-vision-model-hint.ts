import { isMiniMaxM2Model } from "../../../server/services/ai-provider";

export function aiVisionModelHint(provider: string, textModel: string, visionModel: string) {
  if (isMiniMaxM2Model(visionModel)) return "MiniMax M2 系列当前仅支持文本整理，不能用于视觉增强";
  const model = visionModel.trim().toLowerCase();
  if (!model) return "请填写视觉模型名称";
  if (/(?:^|\/)deepseek-v4-flash$/i.test(model)) {
    return "deepseek-v4-flash 是文本模型，不能用于视觉增强；请选择支持图片输入的模型";
  }
  if (textModel.trim() && model === textModel.trim().toLowerCase()) {
    return "视觉模型与文本模型相同，请确认该模型确实支持图片输入";
  }
  if (provider === "ollama" && /^qwen2\.5(?::|$)/i.test(model) && !/vl/i.test(model)) {
    return "qwen2.5 是文本模型，不能用于视觉增强；请关闭视觉增强或改用明确支持图片输入的模型";
  }
  if (/(\b|[-_:])(vl|vision|visual|llava|moondream|internvl|minicpm[-_]?v|idefics|pixtral|qwen[\w.-]*vl|gemma[\w.-]*3)(\b|[-_:])/i.test(model)) {
    return "已识别为可能支持图片输入的模型，请继续测试确认";
  }
  if (/(embedding|rerank|bge[-_]|text[-_]?embedding|nomic[-_]embed|deepseek[-_]?r1|deepseek[-_]?v3|qwen[-_]?(turbo|plus|max)|kimi[-_]|glm[-_]|gpt[-_]?(3\.5|4\.1-mini)|llama[23](\.\d+)?$)/i.test(model)) {
    return "模型名称看起来更像文本模型，建议更换支持图片输入的模型并点击“测试视觉模型”验证";
  }
  return "无法仅根据模型名称确认视觉能力，请点击“测试视觉模型”验证";
}
