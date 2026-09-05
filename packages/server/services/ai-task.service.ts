import { getAiTaskSettings } from "./ai-settings.service";
import {
  executeAiChatCompletion,
  type AiRuntimeRequest,
  type AiRuntimeResponse
} from "./ai-runtime.service";
import { aiTaskDefinition, type AiTaskKey } from "./ai-task-registry";
import { aiProviderHasRequiredApiKey, resolveAiTemperature } from "./ai-provider";

export async function executeAiTask(
  taskKey: AiTaskKey,
  request: AiRuntimeRequest
): Promise<AiRuntimeResponse> {
  const definition = aiTaskDefinition(taskKey);
  if (!definition.implemented) {
    throw Object.assign(new Error(`AI 场景“${definition.label}”尚未启用`), {
      code: "AI_TASK_NOT_IMPLEMENTED",
      taskKey
    });
  }
  const settings = getAiTaskSettings(taskKey, true);
  if (!settings.enabled || !settings.model || !settings.baseUrl ||
      (aiProviderHasRequiredApiKey(settings.provider) && !settings.apiKey)) {
    throw Object.assign(new Error(`AI 场景“${definition.label}”尚未完整配置`), {
      code: "AI_NOT_CONFIGURED",
      taskKey
    });
  }
  return executeAiChatCompletion({
    provider: new URL(settings.baseUrl).host,
    providerKey: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model
  }, {
    ...request,
    temperature: resolveAiTemperature(settings.provider, settings.model, request.temperature)
  });
}
