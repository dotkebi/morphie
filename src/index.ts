// Forky - Code Porting Tool with Local LLM

export { ProjectAnalyzer } from './core/analyzer.js';
export type { ProjectAnalysis, SourceFile, ProjectStructure } from './core/analyzer.js';

export { PortingEngine } from './core/porting-engine.js';
export type { PortedFile } from './core/porting-engine.js';

export { OllamaClient } from './llm/ollama.js';
export type { OllamaModel, GenerateOptions } from './llm/ollama.js';

export { FileSystem } from './utils/filesystem.js';
export {
  detectLanguage,
  getFileExtensions,
  getTargetExtension,
  getLanguageFeatures,
  getSupportedLanguages,
} from './utils/languages.js';
export type { FileType } from './utils/languages.js';
