import type { LLMClient } from '../llm/types.js';
import type { SourceFile } from './analyzer.js';
import { getTargetExtension } from '../utils/languages.js';
import path from 'path';
import { ImportResolver } from '../porting/ImportResolver.js';
import { PromptBuilder } from '../porting/PromptBuilder.js';
import type { PortingPromptOptions } from '../porting/PromptBuilder.js';
import { DartPostProcessor } from '../porting/DartPostProcessor.js';
import { DartValidator } from '../porting/DartValidator.js';

export type { PortingPromptOptions };
export type { ImportMapping, SymbolLocation } from '../porting/ImportResolver.js';

export interface PortedFile {
  targetPath: string;
  content: string;
  originalPath: string;
  skipped?: boolean;
  metadata?: {
    importIssues?: string[];
    requiredImports?: string[];
    actualImports?: string[];
    constObjectWarnings?: string[];
  };
}

interface JsonPortResult {
  code: string;
}
interface JsonMemberPortResult {
  member: string;
}

export class PortingEngine {
  private static hasDumpedPrompt = false;
  private llm: LLMClient;
  private sourceLanguage: string;
  private targetLanguage: string;
  private verbose: boolean;
  private projectName: string;
  private promptBuilder: PromptBuilder;
  private importResolver: ImportResolver;
  private postProcessor: DartPostProcessor;
  private validator: DartValidator;

  constructor(
    llm: LLMClient,
    sourceLanguage: string,
    targetLanguage: string,
    verbose = false,
    projectName = 'project'
  ) {
    this.llm = llm;
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.verbose = verbose;
    this.projectName = this.toSnakeCase(projectName);

    this.importResolver = new ImportResolver(this.projectName, targetLanguage, verbose);
    this.promptBuilder = new PromptBuilder(sourceLanguage, targetLanguage, this.projectName, this.importResolver);
    this.postProcessor = new DartPostProcessor(this.projectName);
    this.validator = new DartValidator(this.projectName);
  }

  setPromptMode(mode: 'full' | 'reduced' | 'minimal'): void {
    this.promptBuilder.setPromptMode(mode);
  }

  setApiSnapshot(snapshot: string): void {
    this.promptBuilder.setApiSnapshot(snapshot);
  }

  public getTargetPath(sourcePath: string): string {
    return this.convertFilePath(sourcePath);
  }

  estimatePromptTokens(file: SourceFile, options: PortingPromptOptions = {}): number {
    const prompt = this.promptBuilder.buildPortingPrompt(file, options);
    return this.promptBuilder.estimateTokens(prompt);
  }

  buildImportMapping(files: SourceFile[]): void {
    this.importResolver.buildMapping(files, (p) => this.convertFilePath(p));
  }

  async portFile(file: SourceFile): Promise<PortedFile> {
    return this.portFileWithOptions(file, {});
  }

  async portDeclarationWithJson(
    file: SourceFile,
    declarationSource: string,
    options: {
      passMode?: 'default' | 'skeleton' | 'body';
      skeletonHint?: string;
      classNameHint?: string;
      debug?: { filePath?: string; unitIndex?: number; totalUnits?: number };
    } = {}
  ): Promise<string> {
    const passMode = options.passMode ?? 'default';
    const prompt = this.promptBuilder.buildDeclarationPrompt(file, declarationSource, options);

    if (this.verbose) {
      const chunkLabel =
        options.debug?.unitIndex !== undefined && options.debug?.totalUnits !== undefined
          ? ` chunk=${options.debug.unitIndex + 1}/${options.debug.totalUnits}`
          : '';
      const sourceLength = declarationSource.length;
      const promptWithoutSource = Math.max(0, prompt.length - sourceLength);
      console.log(
        `[Porting Debug] Prompt stats (${options.debug?.filePath ?? file.relativePath})` +
          ` attempt=1${chunkLabel} mode=json-${passMode} total=${prompt.length}` +
          ` source=${sourceLength} promptWithoutSource=${promptWithoutSource}`
      );
    }

    const raw = await this.llm.generate(prompt, {
      temperature: 0,
      topP: 1,
      verbose: this.verbose,
      timeoutMs: this.getTimeoutForCurrentModel(),
    });

    const parsed = this.parseJsonPortResult(raw);
    if (parsed?.code?.trim()) return parsed.code.trim();

    const fallback = this.extractCode(raw).trim();
    if (fallback) return fallback;
    throw new Error('Failed to extract JSON/code from declaration conversion response');
  }

  async portClassMemberWithJson(
    memberSource: string,
    className: string,
    skeletonHint?: string,
    debug?: { filePath?: string; memberIndex?: number; totalMembers?: number }
  ): Promise<string> {
    const prompt = this.promptBuilder.buildClassMemberPrompt(memberSource, className, skeletonHint);

    if (this.verbose) {
      const chunkLabel =
        debug?.memberIndex !== undefined && debug?.totalMembers !== undefined
          ? ` chunk=${debug.memberIndex + 1}/${debug.totalMembers}`
          : '';
      const sourceLength = memberSource.length;
      const promptWithoutSource = Math.max(0, prompt.length - sourceLength);
      console.log(
        `[Porting Debug] Prompt stats (${debug?.filePath ?? className})` +
          ` attempt=1${chunkLabel} mode=json-member total=${prompt.length}` +
          ` source=${sourceLength} promptWithoutSource=${promptWithoutSource}`
      );
    }

    const raw = await this.llm.generate(prompt, {
      temperature: 0,
      topP: 1,
      verbose: this.verbose,
      timeoutMs: this.getTimeoutForCurrentModel(),
    });

    const parsed = this.parseJsonMemberResult(raw);
    if (parsed?.member?.trim()) return parsed.member.trim();

    return this.extractCode(raw).trim();
  }

  async portFileWithOptions(file: SourceFile, options: PortingPromptOptions = {}): Promise<PortedFile> {
    const targetPath = this.convertFilePath(file.relativePath);
    const isEntryFile = this.promptBuilder.isEntryFilePath(file.relativePath, targetPath);
    const workingFile = options.overrideContent ? { ...file, content: options.overrideContent } : file;

    if (file.type === 'barrel' && this.targetLanguage === 'dart' && file.exports.length === 0) {
      return {
        targetPath,
        content: this.generateDartLibraryExport(file),
        originalPath: file.relativePath,
      };
    }

    const maxAttempts = 2;
    let portedContent = '';
    let importIssues: string[] = [];
    let requiredImports: string[] = [];
    let actualImports: string[] = [];
    let allConstObjectWarnings: string[] = [];
    let lastError: string | null = null;
    let completed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let prompt = this.promptBuilder.buildPortingPrompt(workingFile, options);

      if (this.verbose) {
        const sourceLength = workingFile.content.length;
        const promptWithoutSource = Math.max(0, prompt.length - sourceLength);
        const chunkLabel = options.chunked
          ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
          : '';
        console.log(
          `[Porting Debug] Prompt stats (${workingFile.relativePath}) ` +
            `attempt=${attempt}${chunkLabel} mode=full total=${prompt.length} ` +
            `source=${sourceLength} promptWithoutSource=${promptWithoutSource}`
        );
      }

      if (process.env.MORPHIE_DEBUG_PROMPT === '1' && !PortingEngine.hasDumpedPrompt) {
        const chunkLabel = options.chunked
          ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
          : '';
        console.log(
          `[Porting Debug] Prompt dump (${workingFile.relativePath}) attempt=${attempt}${chunkLabel} mode=full`
        );
        console.log('----- MORPHIE PROMPT START -----');
        console.log(prompt);
        console.log('----- MORPHIE PROMPT END -----');
        PortingEngine.hasDumpedPrompt = true;
      }

      if (this.targetLanguage === 'dart' && attempt > 1 && !options.suppressImports && !isEntryFile) {
        requiredImports = this.importResolver.getRequiredDartImports(file, targetPath);
        if (requiredImports.length > 0) {
          prompt += `\n\n## Import Correction (CRITICAL)\nYou MUST include the exact import statements below:\n${requiredImports.join('\n')}\n`;
        }
      }

      const response = await this.llm.generate(prompt, {
        temperature: 0,
        topP: 1,
        maxTokens: 8192,
        verbose: this.verbose,
        timeoutMs: this.getTimeoutForCurrentModel(),
      });

      if (!response || response.trim() === '') {
        lastError = 'Empty response from LLM';
        if (this.verbose) {
          const chunkLabel = options.chunked
            ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
            : '';
          console.log(`[Porting Debug] Retry reason:${chunkLabel} attempt=${attempt} -> ${lastError}`);
        }
        await this.sleep(this.getBackoffMs(attempt));
        continue;
      }

      portedContent = this.extractCode(response);

      if (!portedContent || portedContent.trim() === '') {
        lastError = 'Failed to extract code from LLM response';
        if (this.verbose) {
          const chunkLabel = options.chunked
            ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
            : '';
          console.log(`[Porting Debug] Retry reason:${chunkLabel} attempt=${attempt} -> ${lastError}`);
        }
        await this.sleep(this.getBackoffMs(attempt));
        continue;
      }

      portedContent = this.importResolver.removeSelfImports(portedContent, targetPath);

      if (this.targetLanguage === 'dart') {
        const isFinalChunk = options.chunked
          ? (options.chunkIndex ?? 0) >= (options.totalChunks ?? 1) - 1
          : true;

        portedContent = this.postProcessor.sanitizeModuleSyntax(portedContent);
        portedContent = this.postProcessor.repairDelimiterBalance(portedContent, !options.chunked || isFinalChunk);
        portedContent = this.postProcessor.mergeDuplicateClasses(portedContent);
        portedContent = this.postProcessor.dedupeTopLevelDeclarations(portedContent);
        portedContent = this.postProcessor.normalizePowUsage(portedContent);
        portedContent = this.postProcessor.normalizeCommonFieldIssues(portedContent);
        portedContent = this.postProcessor.sanitizeTypeScriptResiduals(portedContent);
        portedContent = this.postProcessor.applyAnalyzerHeuristicFixes(portedContent);
        portedContent = this.postProcessor.removeImportedTypeStubs(portedContent, new Set(file.exports.map(e => e.name)));
        portedContent = this.postProcessor.fixStringEnumTypes(portedContent);
        portedContent = this.postProcessor.fixEnumMapTypes(portedContent);

        const constObjectWarnings = this.postProcessor.detectInvalidConstObject(portedContent);
        if (constObjectWarnings.length > 0) {
          console.warn(`[Morphie WARN] ${file.relativePath}: invalid const object literal(s) detected — manual conversion required.`);
          for (const w of constObjectWarnings) console.warn(`  ⚠ ${w}`);
          const warningBlock = constObjectWarnings.map(w => `// MORPHIE WARNING: ${w}`).join('\n');
          portedContent = `${warningBlock}\n\n${portedContent}`;
          allConstObjectWarnings.push(...constObjectWarnings.map(w => `${file.relativePath}: ${w}`));
        }

        let syntaxIssues = this.validator.validateSyntaxHeuristics(portedContent);
        if (options.chunked) {
          const deferred = new Set(['unbalanced braces', 'unbalanced parentheses', 'unbalanced brackets']);
          syntaxIssues = syntaxIssues.filter(issue => !deferred.has(issue));
        }

        if (syntaxIssues.length > 0) {
          lastError = `Syntax gate failed: ${syntaxIssues.join('; ')}`;
          if (this.verbose) {
            const chunkLabel = options.chunked
              ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
              : '';
            console.log(`[Porting Debug] Retry reason:${chunkLabel} attempt=${attempt} -> ${lastError}`);
            if (process.env.MORPHIE_DEBUG_FAILED_OUTPUT === '1') {
              const preview =
                portedContent.length > 800
                  ? `${portedContent.slice(0, 400)}\n...\n${portedContent.slice(-400)}`
                  : portedContent;
              console.log(
                `[Porting Debug] Failed output preview (${workingFile.relativePath}) attempt=${attempt}${chunkLabel}`
              );
              console.log('----- MORPHIE FAILED OUTPUT START -----');
              console.log(preview);
              console.log('----- MORPHIE FAILED OUTPUT END -----');
            }
          }
          await this.sleep(this.getBackoffMs(attempt));
          continue;
        }

        const semanticIssues = this.validator.validateSemanticHeuristics(portedContent);
        const filteredSemanticIssues = options.chunked
          ? semanticIssues.filter(issue => !issue.startsWith('duplicate declaration:'))
          : semanticIssues;
        if (filteredSemanticIssues.length > 0) {
          lastError = `Semantic gate failed: ${filteredSemanticIssues.join('; ')}`;
          if (this.verbose) {
            const chunkLabel = options.chunked
              ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
              : '';
            console.log(`[Porting Debug] Retry reason:${chunkLabel} attempt=${attempt} -> ${lastError}`);
          }
          await this.sleep(this.getBackoffMs(attempt));
          continue;
        }

        if (!options.chunked) {
          const contractIssues = this.validator.validateContractHeuristics(portedContent, file.relativePath);
          if (contractIssues.length > 0) {
            lastError = `Contract gate failed: ${contractIssues.join('; ')}`;
            if (this.verbose) {
              console.log(`[Porting Debug] Retry reason: attempt=${attempt} -> ${lastError}`);
            }
            await this.sleep(this.getBackoffMs(attempt));
            continue;
          }
        }

        portedContent = this.postProcessor.enforceRequiredNamedParams(portedContent);
        portedContent = this.postProcessor.enforceExportedConstNames(portedContent, file);

        // Verify class declarations before import checks — a missing class wrapper
        // (e.g. only a constructor was extracted) must trigger a retry immediately,
        // because it will cause other files to re-invent the class inline.
        if (!options.chunked) {
          const missingClasses = this.verifyExports(file, portedContent)
            .filter(s => s.endsWith('(class)'));
          if (missingClasses.length > 0) {
            lastError = `Missing class declarations: ${missingClasses.join(', ')}`;
            if (this.verbose) {
              console.log(`[Porting Debug] Retry reason: attempt=${attempt} -> ${lastError}`);
              if (process.env.MORPHIE_DEBUG_FAILED_OUTPUT === '1') {
                const preview = portedContent.length > 800
                  ? `${portedContent.slice(0, 400)}\n...\n${portedContent.slice(-400)}`
                  : portedContent;
                console.log(`[Porting Debug] Failed output preview (${workingFile.relativePath}) attempt=${attempt}`);
                console.log('----- MORPHIE FAILED OUTPUT START -----');
                console.log(preview);
                console.log('----- MORPHIE FAILED OUTPUT END -----');
              }
            }
            await this.sleep(this.getBackoffMs(attempt));
            continue;
          }
        }

        if (!options.suppressImports) {
          portedContent = this.ensureDartRequiredImports(portedContent, file);
          if (!isEntryFile) portedContent = this.normalizeDartImports(portedContent, file);

          const validation = this.validator.validateImports(
            portedContent,
            file,
            targetPath,
            this.importResolver.getRequiredDartImports(file, targetPath)
          );
          importIssues = validation.issues;
          requiredImports = validation.requiredImports;
          actualImports = validation.actualImports;

          if (importIssues.length === 0) { completed = true; break; }
          if (this.verbose) {
            const chunkLabel = options.chunked
              ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
              : '';
            console.log(
              `[Porting Debug] Retry reason:${chunkLabel} attempt=${attempt} -> Import issues (${importIssues.length})`
            );
          }
        } else {
          completed = true;
          break;
        }
      } else {
        // Non-Dart: still check for missing class declarations
        if (!options.chunked) {
          const missingClasses = this.verifyExports(file, portedContent)
            .filter(s => s.endsWith('(class)'));
          if (missingClasses.length > 0) {
            lastError = `Missing class declarations: ${missingClasses.join(', ')}`;
            if (this.verbose) {
              console.log(`[Porting Debug] Retry reason: attempt=${attempt} -> ${lastError}`);
              if (process.env.MORPHIE_DEBUG_FAILED_OUTPUT === '1') {
                const preview = portedContent.length > 800
                  ? `${portedContent.slice(0, 400)}\n...\n${portedContent.slice(-400)}`
                  : portedContent;
                console.log(`[Porting Debug] Failed output preview (${workingFile.relativePath}) attempt=${attempt}`);
                console.log('----- MORPHIE FAILED OUTPUT START -----');
                console.log(preview);
                console.log('----- MORPHIE FAILED OUTPUT END -----');
              }
            }
            await this.sleep(this.getBackoffMs(attempt));
            continue;
          }
        }
        completed = true;
        break;
      }
    }

    if (!completed || !portedContent || portedContent.trim() === '') {
      throw new Error(lastError ?? 'Failed to port file');
    }

    if (!options.chunked && this.verbose) {
      const missingExports = this.verifyExports(file, portedContent)
        .filter(s => !s.endsWith('(class)')); // classes already handled above
      if (missingExports.length > 0) {
        console.warn(`⚠️  Warning: Missing non-class exports in ${file.relativePath}: ${missingExports.join(', ')}`);
      }
    }

    return {
      targetPath,
      content: portedContent,
      originalPath: file.relativePath,
      metadata:
        this.targetLanguage === 'dart'
          ? { importIssues, requiredImports, actualImports, constObjectWarnings: allConstObjectWarnings.length > 0 ? allConstObjectWarnings : undefined }
          : undefined,
    };
  }

  validateFinalChunkedOutput(content: string, sourcePath: string): string[] {
    if (this.targetLanguage !== 'dart') return [];
    return this.validator.validateFinalChunkedOutput(content, sourcePath);
  }

  applyContractStubFallback(
    content: string,
    sourcePath: string,
    issues?: string[]
  ): { content: string; injected: string[] } {
    if (this.targetLanguage !== 'dart') return { content, injected: [] };
    return this.postProcessor.applyContractStubFallback(content, sourcePath, issues);
  }

  finalizeImportsForTarget(content: string, currentFilePath: string): string {
    let updated = content;
    if (this.targetLanguage === 'dart') {
      updated = this.postProcessor.sanitizeModuleSyntax(updated);
      updated = this.postProcessor.repairDelimiterBalance(updated, true);
      updated = this.postProcessor.dedupeTopLevelDeclarations(updated);
      updated = this.postProcessor.normalizePowUsage(updated);
      updated = this.postProcessor.normalizeCommonFieldIssues(updated);
      updated = this.postProcessor.narrowImportsByUsage(updated);
    }
    return this.importResolver.removeInvalidImports(updated, currentFilePath);
  }

  finalizeDartChunkedContent(content: string, file: SourceFile): string {
    if (this.targetLanguage !== 'dart') return content;

    const targetPath = this.convertFilePath(file.relativePath);
    const isEntryFile = this.promptBuilder.isEntryFilePath(file.relativePath, targetPath);

    let updated = this.postProcessor.sanitizeModuleSyntax(content);
    updated = this.postProcessor.repairDelimiterBalance(updated, true);
    updated = this.postProcessor.mergeDuplicateClasses(updated);
    updated = this.postProcessor.dedupeTopLevelDeclarations(updated);
    updated = this.postProcessor.repairDelimiterBalance(updated, true);
    updated = this.postProcessor.normalizePowUsage(updated);
    updated = this.postProcessor.normalizeCommonFieldIssues(updated);
    updated = this.postProcessor.sanitizeTypeScriptResiduals(updated);
    updated = this.postProcessor.applyAnalyzerHeuristicFixes(updated);
    updated = this.postProcessor.removeImportedTypeStubs(updated, new Set(file.exports.map(e => e.name)));
    updated = this.postProcessor.fixStringEnumTypes(updated);
    updated = this.postProcessor.fixEnumMapTypes(updated);
    updated = this.postProcessor.narrowImportsByUsage(updated);
    updated = this.ensureDartRequiredImports(updated, file);
    if (!isEntryFile) updated = this.normalizeDartImports(updated, file);
    return this.importResolver.removeInvalidImports(updated, targetPath);
  }

  // ── private helpers ────────────────────────────────────────────────────────

  private ensureDartRequiredImports(content: string, file: SourceFile): string {
    const imports = this.importResolver.extractSourceImports(file.content);
    if (imports.length === 0) return content;

    const targetPath = this.convertFilePath(file.relativePath);
    const requiredImports = new Set(this.importResolver.getRequiredDartImports(file, targetPath));
    if (requiredImports.size === 0) return content;

    const lines = content.split('\n');
    const existingImports = new Set(
      lines.map(l => l.trim()).filter(l => l.startsWith('import '))
    );
    const missing = Array.from(requiredImports).filter(s => !existingImports.has(s));
    if (missing.length === 0) return content;

    let insertAt = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (
        trimmed.startsWith('library ') || trimmed.startsWith('part of ') ||
        trimmed.startsWith('part ') || trimmed.startsWith('import ') || trimmed.startsWith('export ')
      ) {
        insertAt = i + 1;
        continue;
      }
      if (trimmed !== '') break;
    }

    return [
      ...lines.slice(0, insertAt),
      ...missing,
      '',
      ...lines.slice(insertAt),
    ].join('\n').replace(/\n{3,}/g, '\n\n');
  }

  private normalizeDartImports(content: string, file: SourceFile): string {
    const imports = this.importResolver.extractSourceImports(file.content);
    if (imports.length === 0) return content;

    const targetPath = this.convertFilePath(file.relativePath);
    const requiredImports = new Set(this.importResolver.getRequiredDartImports(file, targetPath));

    const lines = content.split('\n');
    const keptLines: string[] = [];
    let insertAt = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('import ')) continue;
      if (
        trimmed.startsWith('library ') || trimmed.startsWith('part of ') ||
        trimmed.startsWith('part ') || trimmed.startsWith('export ')
      ) {
        keptLines.push(lines[i]);
        insertAt = keptLines.length;
        continue;
      }
      keptLines.push(lines[i]);
    }

    const normalizedImports = Array.from(requiredImports);
    if (normalizedImports.length === 0) return keptLines.join('\n');

    return [
      ...keptLines.slice(0, insertAt),
      ...normalizedImports,
      '',
      ...keptLines.slice(insertAt),
    ].join('\n').replace(/\n{3,}/g, '\n\n');
  }

  private generateDartLibraryExport(file: SourceFile): string {
    const exports: string[] = [];
    const content = file.content;
    const exportFromRegex = /export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    const seenPaths = new Set<string>();

    while ((match = exportFromRegex.exec(content)) !== null) {
      const importPath = match[1];
      if (!seenPaths.has(importPath)) {
        seenPaths.add(importPath);
        exports.push(`export '${this.convertImportPath(importPath)}';`);
      }
    }

    if (exports.length === 0) {
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

    const dirName = path.dirname(file.relativePath);
    const libraryName =
      dirName === '.'
        ? 'main'
        : dirName.replace(/[/\\]/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

    let result = `/// Library exports for ${dirName || 'root'}\n`;
    result += `library ${libraryName};\n\n`;
    result += exports.join('\n');

    return result || `// Empty barrel file - no exports found\nlibrary ${libraryName};\n`;
  }

  private convertImportPath(importPath: string): string {
    let dartPath = importPath.replace(/^\.\//, '');
    dartPath = dartPath.replace(/\.(ts|js|tsx|jsx)$/, '');
    dartPath = dartPath.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return dartPath + '.dart';
  }

  private verifyExports(file: SourceFile, portedContent: string): string[] {
    const missing: string[] = [];

    for (const exportSymbol of file.exports) {
      let symbolName = exportSymbol.name;
      if (exportSymbol.parentClass) symbolName = `${exportSymbol.parentClass}${exportSymbol.name}`;

      let found = false;
      if (exportSymbol.type === 'enum') {
        found = new RegExp(`enum\\s+${this.validator.escapeRegex(symbolName)}\\s*[\\{;]`, 'i').test(portedContent);
      } else if (exportSymbol.type === 'interface' || exportSymbol.type === 'type') {
        found =
          new RegExp(`class\\s+${this.validator.escapeRegex(symbolName)}\\s*[\\{;]`, 'i').test(portedContent) ||
          new RegExp(`typedef\\s+${this.validator.escapeRegex(symbolName)}\\s*=`, 'i').test(portedContent);
      } else if (exportSymbol.type === 'class') {
        found = new RegExp(`class\\s+${this.validator.escapeRegex(symbolName)}\\s*[\\{;]`, 'i').test(portedContent);
      } else {
        found = portedContent.includes(symbolName);
      }

      if (!found) missing.push(`${symbolName} (${exportSymbol.type})`);
    }

    return missing;
  }

  private extractCode(response: string): string {
    // Strip thinking blocks from reasoning models:
    // - <think>...</think> (DeepSeek-R1 style)
    // - "Thinking Process:\n..." up to the first code fence (Qwen3.5 style)
    const withoutThink = response
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^Thinking Process:[\s\S]*?(?=```)/i, '')
      .trim();

    const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
    const matches = [...withoutThink.matchAll(codeBlockRegex)];
    if (matches.length > 0) return matches[0][1].trim();

    const cleaned = withoutThink
      .replace(/^```[\w-]*\s*$/gm, '')
      .replace(/^```$/gm, '')
      .trim();
    if (!cleaned) return '';

    const lines = cleaned.split('\n');
    // Only match top-level declarations — NOT bare constructor/method signatures.
    // The old `Identifier(` pattern was too broad: it matched `Glyph(this.code, ...)`
    // which caused class wrappers to be stripped when the LLM omitted code fences.
    const start = lines.findIndex(line => {
      const t = line.trim();
      return (
        /^import\s+['"]/.test(t) ||
        /^(?:abstract\s+)?class\s+[A-Za-z_]\w*/.test(t) ||
        /^enum\s+[A-Za-z_]\w*/.test(t) ||
        /^typedef\s+/.test(t) ||
        /^mixin\s+/.test(t) ||
        /^extension\s+/.test(t) ||
        /^(?:const|final|var)\s+/.test(t)
      );
    });

    return (start >= 0 ? lines.slice(start).join('\n') : cleaned).trim();
  }

  private parseJsonPortResult(raw: string): JsonPortResult | null {
    if (!raw || !raw.trim()) return null;
    const trimmed = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^Thinking Process:[\s\S]*?(?=```|\{)/i, '')
      .trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : trimmed;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const jsonSlice = body.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonSlice) as { code?: unknown };
      if (typeof parsed.code !== 'string') return null;
      return { code: parsed.code };
    } catch {
      // JSON parse failed (e.g. truncated response). Try to extract the "code" string value directly.
      const code = this.extractJsonStringField(jsonSlice, 'code');
      if (code !== null) return { code };
      return null;
    }
  }

  private parseJsonMemberResult(raw: string): JsonMemberPortResult | null {
    if (!raw || !raw.trim()) return null;
    const trimmed = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^Thinking Process:[\s\S]*?(?=```|\{)/i, '')
      .trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : trimmed;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const jsonSlice = body.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonSlice) as { member?: unknown };
      if (typeof parsed.member !== 'string') return null;
      return { member: parsed.member };
    } catch {
      const member = this.extractJsonStringField(jsonSlice, 'member');
      if (member !== null) return { member };
      return null;
    }
  }

  /**
   * Fallback extractor for when JSON.parse fails (e.g. truncated/malformed LLM output).
   * Finds `"fieldName": "..."` in the raw JSON slice and unescapes the string value.
   * Handles the common case where the LLM emits valid JSON content but the closing
   * delimiter is missing or the string contains unescaped inner characters.
   */
  private extractJsonStringField(json: string, field: string): string | null {
    // Match `"field": "` then capture everything up to the closing unescaped `"`
    const fieldPattern = new RegExp(`"${field}"\\s*:\\s*"`, 'i');
    const fieldMatch = fieldPattern.exec(json);
    if (!fieldMatch) return null;

    let valueStart = fieldMatch.index + fieldMatch[0].length;
    let result = '';
    let i = valueStart;
    while (i < json.length) {
      const ch = json[i];
      if (ch === '\\' && i + 1 < json.length) {
        const next = json[i + 1];
        if (next === 'n') { result += '\n'; i += 2; continue; }
        if (next === 'r') { result += '\r'; i += 2; continue; }
        if (next === 't') { result += '\t'; i += 2; continue; }
        if (next === '"') { result += '"'; i += 2; continue; }
        if (next === '\\') { result += '\\'; i += 2; continue; }
        if (next === '/') { result += '/'; i += 2; continue; }
        if (next === 'u' && i + 5 < json.length) {
          const hex = json.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
        }
        result += next;
        i += 2;
        continue;
      }
      if (ch === '"') break; // closing quote
      result += ch;
      i += 1;
    }

    return result.trim() || null;
  }

  private getTimeoutForCurrentModel(): number | undefined {
    const model = this.llm.getModel();
    const reviewerModel = (process.env.MORPHIE_REVIEWER_MODEL ?? '').trim();
    if (reviewerModel && model === reviewerModel) {
      const reviewerTimeout = Number(process.env.MORPHIE_REVIEWER_TIMEOUT_MS ?? '150000');
      if (Number.isFinite(reviewerTimeout) && reviewerTimeout > 0) return Math.floor(reviewerTimeout);
      return 150000;
    }
    const workerTimeout = Number(process.env.MORPHIE_WORKER_TIMEOUT_MS ?? '0');
    if (Number.isFinite(workerTimeout) && workerTimeout > 0) return Math.floor(workerTimeout);
    return undefined;
  }

  private getBackoffMs(attempt: number): number {
    if (attempt <= 1) return 0;
    if (attempt === 2) return 2000;
    if (attempt === 3) return 5000;
    return 10000;
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private convertFilePath(sourcePath: string): string {
    const ext = path.extname(sourcePath);
    const targetExt = getTargetExtension(this.sourceLanguage, this.targetLanguage, ext);
    const basePath = sourcePath.slice(0, -ext.length);
    return this.transformPath(basePath + targetExt);
  }

  private transformPath(filePath: string): string {
    if (this.sourceLanguage === 'python' && ['java', 'kotlin'].includes(this.targetLanguage)) {
      return filePath.replace(/([a-z])_([a-z])/g, (_, a, b) => a + b.toUpperCase());
    }
    if (this.targetLanguage === 'dart') {
      let updatedPath = filePath;
      if (updatedPath.startsWith('src/') || updatedPath.startsWith('src\\')) {
        updatedPath = 'lib/' + updatedPath.slice(4);
      }
      if (['javascript', 'typescript'].includes(this.sourceLanguage)) {
        updatedPath = updatedPath.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      }
      return updatedPath;
    }
    return filePath;
  }

  private toSnakeCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]/g, '_').toLowerCase();
  }
}
