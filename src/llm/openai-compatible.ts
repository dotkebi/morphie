import type { GenerateOptions, LLMClient, LLMModel } from './types.js';

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

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
    // timeoutMs now applies to first-token latency only (via AbortController reset after first chunk)
    const firstTokenTimeoutMs = opts.timeoutMs ?? 0;
    const controller = new AbortController();
    let firstTokenReceived = false;
    let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;

    if (firstTokenTimeoutMs > 0) {
      firstTokenTimer = setTimeout(() => {
        if (!firstTokenReceived) controller.abort();
      }, firstTokenTimeoutMs);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: opts.temperature,
          top_p: opts.topP,
          max_tokens: opts.maxTokens,
          stream: true,
        }),
      });
    } catch (error) {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (!firstTokenReceived && firstTokenTimeoutMs > 0) {
        throw new Error(`LLM request timed out after ${firstTokenTimeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      const error = await response.text();
      if (verbose) {
        console.log(`[OpenAI Debug] Response time (failed): ${Date.now() - startedAt}ms`);
      }
      throw new Error(`OpenAI-compatible generation failed: ${error}`);
    }

    // Read SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!firstTokenReceived) {
          firstTokenReceived = true;
          if (firstTokenTimer) clearTimeout(firstTokenTimer);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const chunk = JSON.parse(trimmed.slice(6)) as OpenAIChatCompletionChunk;
            const token = chunk.choices?.[0]?.delta?.content ?? '';
            if (token) fullContent += token;
          } catch {
            // malformed chunk — skip
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
    }

    if (verbose) {
      console.log(`[OpenAI Debug] Response time: ${Date.now() - startedAt}ms`);
    }

    return fullContent;
  }

  async generateStream(
    prompt: string,
    onToken: (token: string) => void,
    options?: GenerateOptions
  ): Promise<string> {
    // generateStream now leverages the streaming generate() and calls onToken with full result
    const content = await this.generate(prompt, options);
    if (content) onToken(content);
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
