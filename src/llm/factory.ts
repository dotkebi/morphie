import { OllamaClient } from './ollama.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import type { GenerateOptions, LLMClient } from './types.js';

export type LLMProvider = 'ollama' | 'openai';

export interface LLMClientConfig {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  options?: GenerateOptions;
}

export function createLLMClient(config: LLMClientConfig): LLMClient {
  if (config.provider === 'openai') {
    return new OpenAICompatibleClient(
      config.baseUrl,
      config.model,
      config.apiKey,
      config.options
    );
  }

  return new OllamaClient(config.baseUrl, config.model, config.options);
}
