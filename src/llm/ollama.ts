import http from 'http';
import https from 'https';

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

    console.log(`[Ollama Debug] Generating with model: ${this.model}`);
    console.log(`[Ollama Debug] Prompt length: ${prompt.length}`);
    return this.fetchGenerateStream(prompt, opts, () => {});
  }

  async generateStream(
    prompt: string,
    onToken: (token: string) => void,
    options?: GenerateOptions
  ): Promise<string> {
    const opts = { ...this.defaultOptions, ...options };
    return this.fetchGenerateStream(prompt, opts, onToken);
  }

  private async fetchGenerateStream(
    prompt: string,
    opts: GenerateOptions,
    onToken: (token: string) => void
  ): Promise<string> {
    const requestUrl = new URL(`${this.baseUrl}/api/generate`);
    const client = requestUrl.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({
      model: this.model,
      prompt,
      stream: true,
      options: {
        temperature: opts.temperature,
        top_p: opts.topP,
        num_predict: opts.maxTokens,
      },
    });

    return await new Promise<string>((resolve, reject) => {
      const req = client.request(
        {
          method: 'POST',
          protocol: requestUrl.protocol,
          hostname: requestUrl.hostname,
          port: requestUrl.port || (requestUrl.protocol === 'https:' ? 443 : 80),
          path: `${requestUrl.pathname}${requestUrl.search}`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let fullResponse = '';
          let buffer = '';
          let errorBody = '';

          res.setEncoding('utf8');

          if ((res.statusCode ?? 500) >= 400) {
            res.on('data', (chunk: string) => {
              errorBody += chunk;
            });
            res.on('end', () => {
              reject(new Error(`Ollama generation failed: ${errorBody || `HTTP ${res.statusCode}`}`));
            });
            return;
          }

          res.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              try {
                const data = JSON.parse(line) as { response?: string; error?: string };
                if (data.error) {
                  reject(new Error(`Ollama generation failed: ${data.error}`));
                  req.destroy();
                  return;
                }
                if (data.response) {
                  onToken(data.response);
                  fullResponse += data.response;
                }
              } catch {
                // Ignore parse errors for incomplete JSON lines
              }
            }
          });

          res.on('end', () => {
            if (buffer.trim()) {
              try {
                const data = JSON.parse(buffer) as { response?: string; error?: string };
                if (data.error) {
                  reject(new Error(`Ollama generation failed: ${data.error}`));
                  return;
                }
                if (data.response) {
                  onToken(data.response);
                  fullResponse += data.response;
                }
              } catch {
                // Ignore trailing malformed data
              }
            }
            resolve(fullResponse);
          });
        }
      );

      req.setTimeout(0);
      req.on('error', (err: NodeJS.ErrnoException) => {
        console.error(`[Ollama Debug] Request error: ${err.message}${err.code ? ` (code: ${err.code})` : ''}`);
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }
}
