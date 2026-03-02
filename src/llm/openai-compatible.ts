import type { GenerateOptions, LLMClient, LLMModel } from './types.js';

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
}

interface OpenAIModelListResponse {
  data?: Array<{ id: string }>;
}

export class OpenAICompatibleClient implements LLMClient {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private defaultOptions: GenerateOptions;

  constructor(
    baseUrl: string,
    model: string,
    apiKey?: string,
    options: GenerateOptions = {}
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.defaultOptions = {
      temperature: 0.1,
      topP: 0.9,
      maxTokens: 4096,
      ...options,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<LLMModel[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OpenAIModelListResponse;
    return (data.data ?? []).map(model => ({ name: model.id }));
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const opts = { ...this.defaultOptions, ...options };
    const startedAt = Date.now();
    const verbose = options?.verbose === true;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        top_p: opts.topP,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      if (verbose) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[OpenAI Debug] Response time (failed): ${elapsedMs}ms`);
      }
      throw new Error(`OpenAI-compatible generation failed: ${error}`);
    }

    const data = await response.json() as OpenAIChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    if (verbose) {
      const elapsedMs = Date.now() - startedAt;
      console.log(`[OpenAI Debug] Response time: ${elapsedMs}ms`);
    }
    return content;
  }

  async generateStream(
    prompt: string,
    onToken: (token: string) => void,
    options?: GenerateOptions
  ): Promise<string> {
    const content = await this.generate(prompt, options);
    if (content) {
      onToken(content);
    }
    return content;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }
}
