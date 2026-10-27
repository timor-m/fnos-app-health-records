export const feedbackAiFields = ['enabled','visionEnabled','provider','model','visionModel','extractionDepth'] as const;
const providers = new Set(['deepseek','kimi','glm','qwen','openai','doubao','minimax','opencode-go','ollama','custom']);

type AiConfiguration = {
  enabled: boolean; visionEnabled: boolean;
  provider?: unknown; model?: unknown; visionModel?: unknown; extractionDepth?: unknown;
};
export type FeedbackAiSnapshot = {
  enabled: boolean; visionEnabled: boolean;
  provider?: string | null; model?: string | null; visionModel?: string | null;
  extractionDepth?: 'overview' | 'detailed' | null;
};

/** Model identifiers only: exclude addresses, credentials, paths and private deployment IDs. */
export function feedbackModelIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:+@/-]{0,119}$/.test(name)
    || /:\/\/|\.\.|^[a-zA-Z]:[\/\\]|^(?:sk[-_]|ep-|bearer)|^[^/@]+@[^/]+\.[^/]+$/i.test(name)) return null;
  return name;
}

/** Reused for diagnostics, preview and payload; configuration never leaves wholesale. */
export function feedbackAiSnapshot(ai: AiConfiguration): FeedbackAiSnapshot {
  return {
    enabled: ai.enabled, visionEnabled: ai.visionEnabled,
    ...(ai.enabled ? {
      provider: typeof ai.provider === 'string' && providers.has(ai.provider) ? ai.provider : null,
      model: feedbackModelIdentifier(ai.model),
      extractionDepth: ai.extractionDepth === 'overview' || ai.extractionDepth === 'detailed' ? ai.extractionDepth : null,
      ...(ai.visionEnabled ? {visionModel:feedbackModelIdentifier(ai.visionModel)} : {})
    } : {})
  };
}
