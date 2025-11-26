import { OllamaClient } from '../llm/ollama.js';
import { SourceFile } from './analyzer.js';
import { getTargetExtension, getLanguageFeatures } from '../utils/languages.js';
import path from 'path';

export interface PortedFile {
  targetPath: string;
  content: string;
  originalPath: string;
}

export class PortingEngine {
  private llm: OllamaClient;
  private sourceLanguage: string;
  private targetLanguage: string;
  private verbose: boolean;

  constructor(
    llm: OllamaClient,
    sourceLanguage: string,
    targetLanguage: string,
    verbose = false
  ) {
    this.llm = llm;
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.verbose = verbose;
  }

  async portFile(file: SourceFile): Promise<PortedFile> {
    const prompt = this.buildPortingPrompt(file);
    const response = await this.llm.generate(prompt);
    const portedContent = this.extractCode(response);
    const targetPath = this.convertFilePath(file.relativePath);

    return {
      targetPath,
      content: portedContent,
      originalPath: file.relativePath,
    };
  }

  private buildPortingPrompt(file: SourceFile): string {
    const sourceFeatures = getLanguageFeatures(this.sourceLanguage);
    const targetFeatures = getLanguageFeatures(this.targetLanguage);

    return `You are an expert software engineer performing a 1:1 code port from ${this.sourceLanguage} to ${this.targetLanguage}.

## Task
Convert the following ${this.sourceLanguage} code to idiomatic ${this.targetLanguage} code while preserving:
- Exact functionality and behavior
- Code structure and organization
- Function/method signatures (adapted to target language conventions)
- Comments and documentation (translated appropriately)

## Source Language Features
${sourceFeatures}

## Target Language Features
${targetFeatures}

## Guidelines
1. Maintain the same logic and algorithm
2. Use equivalent data structures in the target language
3. Handle error cases the same way (adapted to target language patterns)
4. Preserve any TODO comments or notes
5. Use idiomatic patterns for the target language
6. Include necessary imports/dependencies

## Source Code (${file.relativePath})
\`\`\`${this.sourceLanguage}
${file.content}
\`\`\`

## Ported Code
Provide ONLY the ported code in ${this.targetLanguage}, wrapped in a code block. Do not include explanations.`;
  }

  private extractCode(response: string): string {
    // Try to extract code from markdown code blocks
    const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
    const matches = [...response.matchAll(codeBlockRegex)];

    if (matches.length > 0) {
      // Return the first (and usually only) code block
      return matches[0][1].trim();
    }

    // If no code blocks, return the response as-is (trimmed)
    return response.trim();
  }

  private convertFilePath(sourcePath: string): string {
    const ext = path.extname(sourcePath);
    const targetExt = getTargetExtension(this.sourceLanguage, this.targetLanguage, ext);
    const basePath = sourcePath.slice(0, -ext.length);

    // Convert naming conventions if needed
    let targetPath = basePath + targetExt;

    // Handle language-specific path transformations
    targetPath = this.transformPath(targetPath);

    return targetPath;
  }

  private transformPath(filePath: string): string {
    // Python to other: convert snake_case directories if target uses different convention
    // JavaScript/TypeScript to Python/Dart: convert camelCase to snake_case
    // Add more transformations as needed

    if (this.sourceLanguage === 'python' && ['java', 'kotlin'].includes(this.targetLanguage)) {
      // Convert snake_case to PascalCase for Java/Kotlin class files
      return filePath.replace(/([a-z])_([a-z])/g, (_, a, b) => a + b.toUpperCase());
    }

    if (['javascript', 'typescript'].includes(this.sourceLanguage) && this.targetLanguage === 'dart') {
      // Convert camelCase to snake_case for Dart (Dart convention for file names)
      return filePath.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    }

    return filePath;
  }
}
