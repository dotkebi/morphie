import { OllamaClient } from '../llm/ollama.js';
import { SourceFile } from './analyzer.js';
import { getTargetExtension, getLanguageFeatures } from '../utils/languages.js';
import path from 'path';

export interface PortedFile {
  targetPath: string;
  content: string;
  originalPath: string;
  skipped?: boolean;
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
    const targetPath = this.convertFilePath(file.relativePath);

    // Handle barrel files (index.ts) differently for Dart
    if (file.type === 'barrel' && this.targetLanguage === 'dart') {
      const dartExports = this.generateDartLibraryExport(file);
      return {
        targetPath,
        content: dartExports,
        originalPath: file.relativePath,
      };
    }

    const prompt = this.buildPortingPrompt(file);
    const response = await this.llm.generate(prompt);
    const portedContent = this.extractCode(response);

    return {
      targetPath,
      content: portedContent,
      originalPath: file.relativePath,
    };
  }

  private generateDartLibraryExport(file: SourceFile): string {
    const exports: string[] = [];
    const content = file.content;

    // Parse export statements from TypeScript/JavaScript
    // export { Foo } from './foo';
    // export * from './bar';
    // export { default as Baz } from './baz';

    const exportFromRegex = /export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;
    const exportDefaultRegex = /export\s+\{\s*default\s+as\s+\w+\s*\}\s+from\s+['"]([^'"]+)['"]/g;

    let match;
    const seenPaths = new Set<string>();

    // Match all export from statements
    while ((match = exportFromRegex.exec(content)) !== null) {
      const importPath = match[1];
      if (!seenPaths.has(importPath)) {
        seenPaths.add(importPath);
        const dartPath = this.convertImportPath(importPath);
        exports.push(`export '${dartPath}';`);
      }
    }

    // If no exports found, create exports based on common patterns
    if (exports.length === 0) {
      // Try to find re-exports by looking for export keywords
      const simpleExportRegex = /export\s+\{[^}]+\}\s+from\s+['"]\.\/([^'"]+)['"]/g;
      while ((match = simpleExportRegex.exec(content)) !== null) {
        const fileName = match[1];
        const dartPath = this.convertImportPath(`./${fileName}`);
        if (!seenPaths.has(dartPath)) {
          seenPaths.add(dartPath);
          exports.push(`export '${dartPath}';`);
        }
      }
    }

    // Generate library name from path
    const dirName = path.dirname(file.relativePath);
    const libraryName = dirName === '.'
      ? 'main'
      : dirName.replace(/[\/\\]/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

    let result = `/// Library exports for ${dirName || 'root'}\n`;
    result += `library ${libraryName};\n\n`;
    result += exports.join('\n');

    return result || `// Empty barrel file - no exports found\nlibrary ${libraryName};\n`;
  }

  private convertImportPath(importPath: string): string {
    // Remove ./ prefix if present
    let dartPath = importPath.replace(/^\.\//, '');

    // Remove file extension
    dartPath = dartPath.replace(/\.(ts|js|tsx|jsx)$/, '');

    // Convert camelCase to snake_case
    dartPath = dartPath.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

    // Add .dart extension
    dartPath = dartPath + '.dart';

    return dartPath;
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
