export interface OllamaModel {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export interface GenerateOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private defaultOptions: GenerateOptions;

  constructor(
    baseUrl = 'http://localhost:11434',
    model = 'codellama',
    options: GenerateOptions = {}
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.defaultOptions = {
      temperature: 0.1,
      topP: 0.9,
      maxTokens: 4096,
      ...options,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }

    const data = await response.json() as { models?: Array<{ name: string; size?: number; modified_at?: string }> };

    return (data.models || []).map(m => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
    }));
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const opts = { ...this.defaultOptions, ...options };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: opts.temperature,
          top_p: opts.topP,
          num_predict: opts.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama generation failed: ${error}`);
    }

    const data = await response.json() as { response?: string };
    return data.response || '';
  }

  async generateStream(
    prompt: string,
    onToken: (token: string) => void,
    options?: GenerateOptions
  ): Promise<string> {
    const opts = { ...this.defaultOptions, ...options };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: true,
        options: {
          temperature: opts.temperature,
          top_p: opts.topP,
          num_predict: opts.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama generation failed: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line) as { response?: string; done?: boolean };
          if (data.response) {
            onToken(data.response);
            fullResponse += data.response;
          }
        } catch {
          // Ignore parse errors for incomplete JSON
        }
      }
    }

    return fullResponse;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }
}
