// Morphie - Code Porting Tool with Local LLM

export { ProjectAnalyzer } from './core/analyzer.js';
export type { ProjectAnalysis, SourceFile, ProjectStructure } from './core/analyzer.js';

export { PortingEngine } from './core/porting-engine.js';
export type { PortedFile } from './core/porting-engine.js';

export { OllamaClient } from './llm/ollama.js';
export { OpenAICompatibleClient } from './llm/openai-compatible.js';
export { createLLMClient } from './llm/factory.js';
export type { LLMProvider } from './llm/factory.js';
export type { OllamaModel, GenerateOptions, LLMClient, LLMModel } from './llm/ollama.js';

export { FileSystem } from './utils/filesystem.js';
export {
  detectLanguage,
  getFileExtensions,
  getTargetExtension,
  getLanguageFeatures,
  getSupportedLanguages,
} from './utils/languages.js';
export type { FileType } from './utils/languages.js';

export { generateProjectConfig, generateProjectFiles } from './utils/project-config.js';
export type { ProjectConfigFile, ProjectFiles } from './utils/project-config.js';
