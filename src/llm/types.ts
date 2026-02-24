export interface LLMModel {
  name: string;
  size?: number;
  modifiedAt?: string;
}

export interface GenerateOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface LLMClient {
  healthCheck(): Promise<boolean>;
  listModels(): Promise<LLMModel[]>;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  generateStream(
    prompt: string,
    onToken: (token: string) => void,
    options?: GenerateOptions
  ): Promise<string>;
  setModel(model: string): void;
  getModel(): string;
}
