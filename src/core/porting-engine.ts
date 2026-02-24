import type { LLMClient } from '../llm/types.js';
import { SourceFile, ExportedSymbol } from './analyzer.js';
import { getTargetExtension, getLanguageFeatures } from '../utils/languages.js';
import path from 'path';

export interface SymbolLocation {
  filePath: string;
  symbol: ExportedSymbol;
}

export interface ImportMapping {
  /** Maps symbol name to file path (for simple lookups) */
  symbolToFile: Map<string, string>;
  /** Maps qualified name (e.g., "Stave.Position") to location */
  qualifiedNameToLocation: Map<string, SymbolLocation>;
  /** Maps file path to its exported symbols */
  fileToSymbols: Map<string, ExportedSymbol[]>;
  /** Maps simple name to all locations (for disambiguation) */
  simpleNameToLocations: Map<string, SymbolLocation[]>;
  /** Maps source relative path to target path (for import resolution) */
  sourcePathToTargetPath: Map<string, string>;
}

export interface PortedFile {
  targetPath: string;
  content: string;
  originalPath: string;
  skipped?: boolean;
  metadata?: {
    importIssues?: string[];
    requiredImports?: string[];
    actualImports?: string[];
  };
}

export interface PortingPromptOptions {
  overrideContent?: string;
  chunked?: boolean;
  chunkIndex?: number;
  totalChunks?: number;
  suppressImports?: boolean;
}

export class PortingEngine {
  private static hasDumpedPrompt = false;
  private llm: LLMClient;
  private sourceLanguage: string;
  private targetLanguage: string;
  private verbose: boolean;
  private projectName: string;
  private importMapping: ImportMapping;
  private promptMode: 'full' | 'reduced' | 'minimal';

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
    this.importMapping = {
      symbolToFile: new Map(),
      qualifiedNameToLocation: new Map(),
      fileToSymbols: new Map(),
      simpleNameToLocations: new Map(),
      sourcePathToTargetPath: new Map(),
    };
    this.promptMode = 'full';
  }

  setPromptMode(mode: 'full' | 'reduced' | 'minimal'): void {
    this.promptMode = mode;
  }

  public getTargetPath(sourcePath: string): string {
    return this.convertFilePath(sourcePath);
  }

  estimatePromptTokens(
    file: SourceFile,
    options: PortingPromptOptions = {}
  ): number {
    const prompt = this.buildPortingPrompt(file, options);
    return this.estimateTokens(prompt);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  buildImportMapping(files: SourceFile[]): void {
    for (const file of files) {
      const targetPath = this.convertFilePath(file.relativePath);

      // Map source path to target path for import resolution
      this.importMapping.sourcePathToTargetPath.set(file.relativePath, targetPath);

      this.importMapping.fileToSymbols.set(targetPath, file.exports);

      for (const symbol of file.exports) {
        const location: SymbolLocation = { filePath: targetPath, symbol };

        // Map by qualified name (unique)
        this.importMapping.qualifiedNameToLocation.set(symbol.qualifiedName, location);

        // Map by simple name (may have duplicates)
        this.importMapping.symbolToFile.set(symbol.name, targetPath);

        // Track all locations for a simple name (for disambiguation)
        if (!this.importMapping.simpleNameToLocations.has(symbol.name)) {
          this.importMapping.simpleNameToLocations.set(symbol.name, []);
        }
        this.importMapping.simpleNameToLocations.get(symbol.name)!.push(location);
      }
    }
  }

  private toSnakeCase(str: string): string {
    return str
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[-\s]/g, '_')
      .toLowerCase();
  }

  async portFile(file: SourceFile): Promise<PortedFile> {
    return this.portFileWithOptions(file, {});
  }

  async portFileWithOptions(
    file: SourceFile,
    options: PortingPromptOptions = {}
  ): Promise<PortedFile> {
    const targetPath = this.convertFilePath(file.relativePath);
    const workingFile = options.overrideContent
      ? { ...file, content: options.overrideContent }
      : file;

    // Handle barrel files (index.ts) differently for Dart
    if (file.type === 'barrel' && this.targetLanguage === 'dart' && file.exports.length === 0) {
      const dartExports = this.generateDartLibraryExport(file);
      return {
        targetPath,
        content: dartExports,
        originalPath: file.relativePath,
      };
    }

    const maxAttempts = this.targetLanguage === 'dart' ? 4 : 3;
    let portedContent = '';
    let importIssues: string[] = [];
    let requiredImports: string[] = [];
    let actualImports: string[] = [];
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let prompt = this.buildPortingPrompt(workingFile, options);
      if (this.verbose) {
        const sourceLength = workingFile.content.length;
        const importContextLength = options.suppressImports ? 0 : this.buildImportContext(workingFile).length;
        const promptWithoutSource = Math.max(0, prompt.length - sourceLength);
        const chunkLabel = options.chunked
          ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
          : '';
        console.log(
          `[Porting Debug] Prompt stats (${workingFile.relativePath}) ` +
          `attempt=${attempt}${chunkLabel} mode=${this.promptMode} total=${prompt.length} ` +
          `source=${sourceLength} importContext=${importContextLength} promptWithoutSource=${promptWithoutSource}`
        );
      }
      if (process.env.MORPHIE_DEBUG_PROMPT === '1' && !PortingEngine.hasDumpedPrompt) {
        const chunkLabel = options.chunked
          ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
          : '';
        console.log(
          `[Porting Debug] Prompt dump (${workingFile.relativePath}) attempt=${attempt}${chunkLabel} mode=${this.promptMode}`
        );
        console.log('----- MORPHIE PROMPT START -----');
        console.log(prompt);
        console.log('----- MORPHIE PROMPT END -----');
        PortingEngine.hasDumpedPrompt = true;
      }

      if (this.targetLanguage === 'dart' && attempt > 1 && !options.suppressImports) {
        requiredImports = this.getRequiredDartImports(file, targetPath);
        if (requiredImports.length > 0) {
          prompt += `\n\n## Import Correction (CRITICAL)\nYou MUST include the exact import statements below:\n${requiredImports.join('\n')}\n`;
        }
      }

      const response = await this.llm.generate(prompt, {
        temperature: 0,
        topP: 1,
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

      // Remove self-imports (import statements that reference the current file)
      portedContent = this.removeSelfImports(portedContent, targetPath);

      // Defer invalid-import cleanup to a final post-processing pass

      if (this.targetLanguage === 'dart') {
        portedContent = this.enforceDartRequiredNamedParams(portedContent);
        portedContent = this.enforceDartExportedConstNames(portedContent, file);
        if (!options.suppressImports) {
          portedContent = this.ensureDartRequiredImports(portedContent, file);
          portedContent = this.normalizeDartImports(portedContent, file);

          const validation = this.validateDartImports(portedContent, file, targetPath);
          importIssues = validation.issues;
          requiredImports = validation.requiredImports;
          actualImports = validation.actualImports;

          if (importIssues.length === 0) {
            break;
          }
          if (this.verbose) {
            const chunkLabel = options.chunked
              ? ` chunk=${(options.chunkIndex ?? 0) + 1}/${options.totalChunks ?? 1}`
              : '';
            console.log(
              `[Porting Debug] Retry reason:${chunkLabel} attempt=${attempt} -> Import issues (${importIssues.length})`
            );
          }
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (!portedContent || portedContent.trim() === '') {
      throw new Error(lastError ?? 'Failed to port file');
    }

    // Verify that all exports are included
    if (!options.chunked) {
      const missingExports = this.verifyExports(file, portedContent);
      if (missingExports.length > 0 && this.verbose) {
        console.warn(`⚠️  Warning: Missing exports in ${file.relativePath}: ${missingExports.join(', ')}`);
      }
    }

    return {
      targetPath,
      content: portedContent,
      originalPath: file.relativePath,
      metadata: this.targetLanguage === 'dart'
        ? {
          importIssues,
          requiredImports,
          actualImports,
        }
        : undefined,
    };
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

  /**
   * Verifies that all exported symbols from the source file are present in the ported content
   * Returns array of missing symbol names
   */
  private verifyExports(file: SourceFile, portedContent: string): string[] {
    const missing: string[] = [];

    for (const exportSymbol of file.exports) {
      let symbolName = exportSymbol.name;

      // If it's a nested symbol, check for the flattened name (ParentChild)
      if (exportSymbol.parentClass) {
        symbolName = `${exportSymbol.parentClass}${exportSymbol.name}`;
      }

      // Check if the symbol appears in the ported content
      // For Dart, check for enum, class, typedef definitions
      let found = false;

      if (exportSymbol.type === 'enum') {
        // Check for enum definition
        const enumPattern = new RegExp(`enum\\s+${this.escapeRegex(symbolName)}\\s*[\\{;]`, 'i');
        found = enumPattern.test(portedContent);
      } else if (exportSymbol.type === 'interface' || exportSymbol.type === 'type') {
        // Check for class or typedef definition
        const classPattern = new RegExp(`class\\s+${this.escapeRegex(symbolName)}\\s*[\\{;]`, 'i');
        const typedefPattern = new RegExp(`typedef\\s+${this.escapeRegex(symbolName)}\\s*=`, 'i');
        found = classPattern.test(portedContent) || typedefPattern.test(portedContent);
      } else if (exportSymbol.type === 'class') {
        // Check for class definition
        const classPattern = new RegExp(`class\\s+${this.escapeRegex(symbolName)}\\s*[\\{;]`, 'i');
        found = classPattern.test(portedContent);
      } else {
        // For functions, const, etc., just check if name appears
        found = portedContent.includes(symbolName);
      }

      if (!found) {
        missing.push(`${symbolName} (${exportSymbol.type})`);
      }
    }

    return missing;
  }

  private generateDartLibraryExport(file: SourceFile): string {
    const exports: string[] = [];
    const content = file.content;

    // Parse export statements from TypeScript/JavaScript
    // export { Foo } from './foo';
    // export * from './bar';
    // export { default as Baz } from './baz';

    const exportFromRegex = /export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

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
      : dirName.replace(/[/\\]/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

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

  /**
   * Resolves an import path from source file to target file path
   * Uses the sourcePathToTargetPath mapping to find the actual target path
   * Returns null if the import path resolves to the same file (self-import)
   */
  private resolveImportPath(importPath: string, fromSourcePath: string): string | null {
    // Normalize the import path relative to the source file
    const sourceDir = path.dirname(fromSourcePath);
    let resolvedSourcePath = path.normalize(
      path.join(sourceDir, importPath)
    ).replace(/\\/g, '/');

    // Check if this resolves to the same file (self-import) - should not happen
    const fromSourceWithoutExt = fromSourcePath.replace(/\.(ts|js|tsx|jsx)$/, '');
    const resolvedWithoutExt = resolvedSourcePath.replace(/\.(ts|js|tsx|jsx)$/, '');

    // Prevent self-import
    if (resolvedWithoutExt === fromSourceWithoutExt ||
      resolvedSourcePath === fromSourcePath) {
      return null; // Self-import detected
    }

    // Strategy 1: Try exact match first (with extension)
    if (this.importMapping.sourcePathToTargetPath.has(resolvedSourcePath)) {
      return this.importMapping.sourcePathToTargetPath.get(resolvedSourcePath)!;
    }

    // Strategy 2: Try without extension (match by base path)
    for (const [sourcePath, targetPath] of this.importMapping.sourcePathToTargetPath) {
      const sourceWithoutExt = sourcePath.replace(/\.(ts|js|tsx|jsx)$/, '');
      if (sourceWithoutExt === resolvedWithoutExt) {
        return targetPath;
      }
    }

    // Strategy 3: Try index file in directory (barrel files)
    const indexPaths = [
      resolvedWithoutExt + '/index.ts',
      resolvedWithoutExt + '/index.js',
      resolvedWithoutExt + '/index.tsx',
      resolvedWithoutExt + '/index.jsx',
    ];

    for (const indexPath of indexPaths) {
      if (this.importMapping.sourcePathToTargetPath.has(indexPath)) {
        return this.importMapping.sourcePathToTargetPath.get(indexPath)!;
      }
    }

    // Strategy 4: Try directory match (for barrel files)
    // If import points to a directory, find index file in that directory
    for (const [sourcePath, targetPath] of this.importMapping.sourcePathToTargetPath) {
      const sourcePathDir = path.dirname(sourcePath).replace(/\\/g, '/');
      const sourcePathBase = path.basename(sourcePath, path.extname(sourcePath));

      // Check if the directory matches and it's an index file
      if (sourcePathDir === resolvedWithoutExt &&
        (sourcePathBase === 'index' || sourcePathBase === resolvedWithoutExt.split('/').pop())) {
        return targetPath;
      }
    }

    // Strategy 5: Try partial match (for nested imports)
    // e.g., if import is './foo' and we have './foo/bar.ts', try to find './foo/index.ts'
    const resolvedDir = resolvedWithoutExt;
    for (const [sourcePath, targetPath] of this.importMapping.sourcePathToTargetPath) {
      const sourcePathDir = path.dirname(sourcePath).replace(/\\/g, '/');
      if (sourcePathDir === resolvedDir) {
        // Found a file in the target directory, check if there's an index
        const targetDir = path.dirname(targetPath).replace(/\\/g, '/');
        const possibleIndex = targetDir + '/index.dart';
        if (this.importMapping.fileToSymbols.has(possibleIndex)) {
          return possibleIndex;
        }
        // If no index, return the first file found (might not be ideal, but better than nothing)
        if (this.verbose) {
          console.warn(`Warning: No index file found for directory ${resolvedDir}, using ${targetPath}`);
        }
        return targetPath;
      }
    }

    return null;
  }

  private buildImportContext(file: SourceFile): string {
    if (this.targetLanguage !== 'dart') {
      return '';
    }

    // Extract imports from the source file
    const importRegex = /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    const imports: Array<{ path: string; symbols: string[] }> = [];
    let match;

    while ((match = importRegex.exec(file.content)) !== null) {
      const importPath = match[1];
      // Extract symbol names from import statement
      const symbolMatch = match[0].match(/import\s+\{([^}]+)\}/);
      const symbols = symbolMatch
        ? symbolMatch[1].split(',').map(s => s.trim().split(' as ')[0].trim())
        : [];
      imports.push({ path: importPath, symbols });
    }

    if (imports.length === 0 && this.importMapping.symbolToFile.size === 0) {
      return '';
    }

    const currentTargetPath = this.convertFilePath(file.relativePath);
    const currentDir = path.dirname(currentTargetPath);

    // Get symbols defined in the current file (should NOT be imported)
    const currentFileSymbols = file.exports.map(s => s.name);

    // Group symbols by type for clearer checklist
    const symbolsByType = {
      enum: file.exports.filter(s => s.type === 'enum'),
      interface: file.exports.filter(s => s.type === 'interface'),
      type: file.exports.filter(s => s.type === 'type'),
      class: file.exports.filter(s => s.type === 'class'),
      function: file.exports.filter(s => s.type === 'function'),
      const: file.exports.filter(s => s.type === 'const'),
    };

    const lines: string[] = [
      '## Import Path Mapping (CRITICAL)',
      `Package name: \`${this.projectName}\``,
      `Current file: \`${currentTargetPath}\``,
      '',
      `### Symbols defined in THIS file (MUST be included in the output - DO NOT import these):`,
      currentFileSymbols.length > 0
        ? `**MANDATORY exports to include: ${currentFileSymbols.join(', ')}**`
        : '- None',
      '',
      `**CRITICAL**: The source file exports ${currentFileSymbols.length} symbol(s). You MUST include ALL of them in your output. Do NOT skip any enum, interface, type, or class definitions.`,
      '',
      `**MANDATORY CHECKLIST - Your output MUST include ALL of these**:
      ${symbolsByType.enum.length > 0 ? `- Enums: ${symbolsByType.enum.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.interface.length > 0 ? `- Interfaces (convert to class): ${symbolsByType.interface.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.type.length > 0 ? `- Types (convert to typedef or class): ${symbolsByType.type.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.class.length > 0 ? `- Classes: ${symbolsByType.class.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.function.length > 0 ? `- Functions: ${symbolsByType.function.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.const.length > 0 ? `- Constants: ${symbolsByType.const.map(s => s.name).join(', ')}` : ''}
      ${currentFileSymbols.length === 0 ? '- None (but check for non-exported interfaces/types in the source code)' : ''}`,
      '',
      '### Import Rules:',
      `1. Use package imports for files in different directories: \`import 'package:${this.projectName}/path/to/file.dart';\``,
      `2. Use relative imports ONLY for files in the same directory: \`import 'file.dart';\``,
      '3. File paths must use snake_case (e.g., `my_class.dart` not `MyClass.dart`)',
      '4. NEVER invent package names or file names - only use paths that exist in the import mapping below',
      '5. All enums, interfaces, and types defined in the source file MUST be included in the same target file',
      '6. DO NOT create separate files for enums/types that are in the same source file',
      '',
    ];

    // Build import mapping for symbols used in this file
    if (imports.length > 0) {
      lines.push('### Required imports for this file:');

      for (const imp of imports) {
        // Resolve import path using the mapping
        const targetPath = this.resolveImportPath(imp.path, file.relativePath);

        // Skip self-imports (should not happen, but filter just in case)
        if (targetPath && targetPath === currentTargetPath) {
          if (this.verbose) {
            lines.push(`- \`${imp.path}\` → ⚠️  SKIPPED (self-import)`);
          }
          continue;
        }

        if (targetPath) {
          // Use the actual target path from mapping
          const importDir = path.dirname(targetPath).replace(/\\/g, '/');
          const normalizedCurrentDir = currentDir.replace(/\\/g, '/');

          // Check if same directory for relative import
          lines.push(`- \`${imp.path}\` → \`${this.buildDartImportStatement(targetPath, currentTargetPath)}\``);
        } else {
          // Fallback: convert path manually if not found in mapping
          // This should rarely happen, but provides a fallback
          const resolvedSourcePath = path.normalize(
            path.join(path.dirname(file.relativePath), imp.path)
              .replace(/\.(ts|js|tsx|jsx)$/, '')
          ).replace(/\\/g, '/');

          const dartPath = this.transformPath(this.toSnakeCase(resolvedSourcePath) + '.dart');
          const importDir = path.dirname(dartPath).replace(/\\/g, '/');
          const normalizedCurrentDir = currentDir.replace(/\\/g, '/');

          lines.push(`- \`${imp.path}\` → \`${this.buildDartImportStatement(dartPath, currentTargetPath)}\``);

          if (this.verbose) {
            lines.push(`  ⚠️  Warning: Could not resolve import path "${imp.path}" - using fallback conversion`);
          }
        }
      }
      lines.push('');
    }

    // Find nested enums/types that need qualified access
    const nestedTypes = this.findNestedTypesInFile(file);
    if (nestedTypes.length > 0) {
      lines.push('### Nested Types (IMPORTANT - EXTRACT to top-level):');
      lines.push('These enums/types are defined INSIDE their parent class. Extract them to top-level and rename them:');
      for (const nested of nestedTypes) {
        lines.push(`- \`${nested.qualifiedName}\` → extract as \`${nested.parentClass}${nested.name}\` (Top-level)`);
      }
      lines.push('');
    }

    // Find symbols with multiple definitions (need disambiguation)
    const ambiguousSymbols = this.findAmbiguousSymbols(file);
    if (ambiguousSymbols.length > 0) {
      lines.push('### Ambiguous Symbols (Multiple definitions exist):');
      lines.push('These symbol names exist in multiple places. Use the CORRECT one based on context:');
      for (const amb of ambiguousSymbols) {
        lines.push(`- \`${amb.name}\`:`);
        for (const loc of amb.locations) {
          if (loc.symbol.parentClass) {
            lines.push(`  - \`${loc.symbol.qualifiedName}\` in \`${loc.filePath}\` (nested in ${loc.symbol.parentClass})`);
          } else {
            lines.push(`  - \`${loc.symbol.qualifiedName}\` in \`${loc.filePath}\` (top-level)`);
          }
        }
      }
      lines.push('');
    }

    // Add symbol to file mapping for commonly used symbols
    if (this.importMapping.qualifiedNameToLocation.size > 0) {
      const relevantSymbols: string[] = [];
      const symbolToImport = new Map<string, string>(); // Deduplicate by symbol name

      // Find symbols that might be referenced in this file
      for (const [qualifiedName, location] of this.importMapping.qualifiedNameToLocation) {
        const { filePath, symbol } = location;
        if (filePath === currentTargetPath) continue;

        // Check if this symbol is used in the file (by name or qualified name)
        const isUsed = file.content.includes(symbol.name) ||
          file.content.includes(qualifiedName) ||
          (symbol.parentClass && file.content.includes(`${symbol.parentClass}.${symbol.name}`));

        if (isUsed) {
          const importDir = path.dirname(filePath).replace(/\\/g, '/');
          const normalizedCurrentDir = currentDir.replace(/\\/g, '/');

          // Determine import statement
          let importStatement: string;
          importStatement = this.buildDartImportStatement(filePath, currentTargetPath);

          if (symbol.parentClass) {
            // Nested type - show flattened access
            const key = qualifiedName;
            if (!symbolToImport.has(key)) {
              symbolToImport.set(key, `- \`${qualifiedName}\` → ${importStatement} then use \`${symbol.parentClass}${symbol.name}\` (Top-level)`);
            }
          } else {
            // Top-level symbol
            const key = symbol.name;
            if (!symbolToImport.has(key)) {
              symbolToImport.set(key, `- \`${symbol.name}\` → ${importStatement}`);
            }
          }
        }
      }

      if (symbolToImport.size > 0) {
        lines.push('### Symbol locations (use these exact imports):');
        lines.push('These symbols are referenced in the code. Use the exact import paths below:');
        lines.push(...Array.from(symbolToImport.values()).slice(0, 40));
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private findNestedTypesInFile(file: SourceFile): ExportedSymbol[] {
    const currentTargetPath = this.convertFilePath(file.relativePath);
    const symbols = this.importMapping.fileToSymbols.get(currentTargetPath) || [];
    return symbols.filter(s => s.parentClass);
  }

  private findAmbiguousSymbols(file: SourceFile): Array<{ name: string; locations: SymbolLocation[] }> {
    const result: Array<{ name: string; locations: SymbolLocation[] }> = [];

    for (const [name, locations] of this.importMapping.simpleNameToLocations) {
      // Only include if there are multiple definitions AND the symbol is used in this file
      if (locations.length > 1 && file.content.includes(name)) {
        result.push({ name, locations });
      }
    }

    return result.slice(0, 10); // Limit to avoid too long prompts
  }

  private buildPortingPrompt(file: SourceFile, options: PortingPromptOptions = {}): string {
    if (this.promptMode === 'minimal') {
      return this.buildMinimalPrompt(file, options);
    }

    const sourceFeatures = getLanguageFeatures(this.sourceLanguage);
    const targetFeatures = getLanguageFeatures(this.targetLanguage);
    const importContext = options.suppressImports ? '' : this.buildImportContext(file);
    const sourceContent = options.overrideContent ?? file.content;
    const chunkNotice = options.chunked
      ? `## Chunked Porting (CRITICAL)
You are porting chunk ${options.chunkIndex! + 1} of ${options.totalChunks!} from a larger file.
- Output ONLY the code for this chunk, in correct order.
- Do NOT add extra commentary.
- ${options.suppressImports ? 'Do NOT include any import statements in this chunk.' : 'Include necessary import statements only if they belong at the top of the file.'}
`
      : '';

    const fullPrompt = `You are an expert software engineer performing a 1:1 code port from ${this.sourceLanguage} to ${this.targetLanguage}.

## Task
Convert the following ${this.sourceLanguage} code to idiomatic ${this.targetLanguage} code while preserving:
- Exact functionality and behavior
- Code structure and organization (if a method is inside a class, keep it inside the class - do NOT extract methods as top-level functions)
- Function/method signatures (adapted to target language conventions)
- Comments and documentation (translated appropriately)
- **CRITICAL: Include ALL methods, including private methods** - If the source has \`private addListener(...)\`, you MUST include the converted private method in the output. Do NOT skip private methods.
- **CRITICAL: Do NOT add organizational comments** - Do NOT add comments like "// Ported from ...", "// Enums", "// Interfaces/Types", "// Classes", "// Functions", etc. Just write the code directly without section dividers.

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
7. **CRITICAL: NEVER import the current file itself** - Do not add import statements that reference the file you are currently porting
8. **CRITICAL: Keep all definitions in the same file** - If enums, interfaces, or types are defined in the source file alongside classes, they MUST be included in the same target file. Do NOT create separate files or import statements for symbols that are defined in the current file.
9. **CRITICAL: Include non-exported interfaces/types** - Even if an interface or type is NOT exported (e.g., \`interface EventListener\`), if it is used in the file, it MUST be included in the output
10. **CRITICAL: Do NOT convert string types to enums** - If a TypeScript type is \`string\`, keep it as \`String\` in Dart. Do NOT create enums for string values unless the source code explicitly uses an enum type
11. **CRITICAL: Type aliases are NOT enums** - \`export type\` in TypeScript should become \`typedef\` (for functions) or \`class\` (for objects) in Dart. NEVER convert \`type\` to \`enum\`
12. **CRITICAL: Include ALL methods, including private methods** - If a class has \`private addListener(...)\` in TypeScript, you MUST include it as \`void _addListener(...)\` in Dart (Dart uses underscore prefix for private). Do NOT skip any methods, whether public or private.

${importContext}

${chunkNotice}

## Dart Constructor & Constant Rules (CRITICAL)
1. **Named Parameters Validation**:
   - For non-nullable fields in a class with named parameters, you MUST use the required keyword.
   - WRONG: const Config({this.port}); (if port is final int port)
   - RIGHT: const Config({required this.port});
   - Exception: If the field is nullable (e.g., final int? port), then required is optional.

2. **Top-Level Constants to Class Conversion**:
   - If the source has a top-level constant object (e.g., export const CONFIG = { ... }), convert it to:
     1. A Dart class definition defining the structure.
     2. A global constant instance of that class.
   - **CRITICAL: Preserve the constant identifier name exactly (case-sensitive)**. If the source is \`CONFIG\`, the Dart constant must be named \`CONFIG\`.
   - Example:
     Source: export const CONFIG = { port: 3000 };
     Target:
     \\\`\\\`\\\`dart
     class Config {
       final int port;
       const Config({required this.port});
     }
     
     const CONFIG = Config(port: 3000);
     \\\`\\\`\\\`

## TypeScript to Dart Enum Conversion
When converting TypeScript enums with explicit values to Dart, use enhanced enums.

**IMPORTANT**: The examples below are for REFERENCE ONLY. Do NOT include these example comments or code in your output. Only generate the actual ported code for the source file provided.

### Numeric Enum Values
For TypeScript \`enum Position { LEFT = 1, RIGHT = 2, ABOVE = 3 }\`, convert to:
\`\`\`dart
enum Position {
  left(1),
  right(2),
  above(3);

  final int value;
  const Position(this.value);
}
\`\`\`

### String Enum Values (CRITICAL)
For TypeScript string enums like \`enum Operation { ADD = 'add', SUBTRACT = 'subtract' }\`, convert to:
\`\`\`dart
enum Operation {
  add('add'),
  subtract('subtract');

  final String value;
  const Operation(this.value);
}
\`\`\`

**Conversion Rules**: 
- Dart enum values must be lowercase (Dart naming convention)
- String enum values require a \`final String value\` field and constructor
- The enum name itself remains PascalCase, but values are camelCase/lowercase
- Usage: \`Operation.add.value\` returns \`'add'\`, \`Operation.add\` is the enum instance
- **DO NOT include example comments like "// TypeScript - string enum" in your output**

## Nested Enums/Types (CRITICAL)
When TypeScript has static enums/objects INSIDE a class, convert them to **TOP-LEVEL** enums/classes.

For TypeScript \`class Stave { static Position = { ABOVE: 0, BELOW: 1 }; }\`, convert to:
\`\`\`dart
class Stave {
  // Class implementation
}

// EXTRACTED to top-level
enum StavePosition {
  above(0),
  below(1);

  final int value;
  const StavePosition(this.value);
}
\`\`\`

**IMPORTANT**: 
- **DO NOT** keep enums nested inside classes. Dart supports nested classes but it's better to keep them top-level for cleaner imports.
- Rename the extracted enum by prefixing the parent class name (e.g., \`Stave.Position\` → \`StavePosition\`, \`Modifier.Position\` → \`ModifierPosition\`).
- **DO NOT** create duplicate top-level enums with the same name.
- **DO NOT** include example comments or TypeScript code in your output.

## TypeScript Interface to Dart Conversion
TypeScript interfaces must be converted to Dart classes. Dart does not have interfaces, but all classes are implicit interfaces.

For TypeScript \`interface CalculationResult { operation: Operation; operands: number[]; result: number; timestamp: Date; }\`, convert to:
\`\`\`dart
class CalculationResult {
  final Operation operation;
  final List<num> operands;
  final num result;
  final DateTime timestamp;

  const CalculationResult(this.operation, this.operands, this.result, this.timestamp);
}
\`\`\`

For TypeScript \`interface ShapeMetadata { name: string; color?: string; createdAt: Date; }\`, convert to:
\`\`\`dart
class ShapeMetadata {
  final String name;
  final String? color;
  final DateTime createdAt;

  const ShapeMetadata({required this.name, this.color, required this.createdAt});
}
\`\`\`

**Conversion Rules**:
- TypeScript \`interface\` → Dart \`class\` (Dart does not have interfaces, all classes are implicit interfaces)
- **CRITICAL: Include ALL interfaces, even if they are NOT exported** - If an interface is used in the file (even if not exported like \`interface EventListener\`), it MUST be included in the output as a class
- **MANDATORY: Every interface in the source code MUST appear in the output** - Check the source code carefully for ALL interface definitions, both exported and non-exported
- **Example**: If source has \`interface EventListener { callback: EventCallback; once: boolean; }\`, you MUST include:
  \`\`\`dart
  class EventListener {
    final EventCallback callback;
    final bool once;
    
    const EventListener({required this.callback, required this.once});
  }
  \`\`\`
- Optional properties (\`color?: string\`) → Nullable types (\`String? color\`)
- Use named parameters for constructors when appropriate
- Use \`required\` keyword for non-nullable required fields
- All interface definitions MUST be included in the output (both exported and non-exported)

## TypeScript Type Alias to Dart Conversion
TypeScript type aliases must be converted to Dart typedefs or classes depending on the type.

**CRITICAL: Type aliases are NEVER enums. NEVER use enum for type aliases.**

For function type aliases like \`export type EventCallback<T = unknown> = (data: T) => void;\`, convert to:
\`\`\`dart
typedef EventCallback<T> = void Function(T data);
\`\`\`

**WRONG - DO NOT DO THIS**:
\`\`\`dart
// WRONG - Type aliases are NOT enums!
enum EventCallback<T> { ... }  // NEVER DO THIS
\`\`\`

For object type aliases like \`export type TaskFilter = { status?: TaskStatus; priority?: TaskPriority; tag?: string; };\`, convert to:
\`\`\`dart
class TaskFilter {
  final TaskStatus? status;
  final TaskPriority? priority;
  final String? tag;

  const TaskFilter({this.status, this.priority, this.tag});
}
\`\`\`

**Conversion Rules**:
- **Function type aliases → \`typedef\` ONLY** - \`export type EventCallback<T> = (data: T) => void;\` becomes \`typedef EventCallback<T> = void Function(T data);\`
- **Object type aliases → \`class\` ONLY** - Object types become classes with nullable optional fields
- **CRITICAL: Type aliases are NEVER enums** - Do NOT convert \`type\` to \`enum\`. Type aliases are either \`typedef\` (for functions) or \`class\` (for objects)
- **NEVER use enum syntax for type aliases** - If you see \`export type\`, it is ALWAYS either \`typedef\` or \`class\`, NEVER \`enum\`
- **WRONG EXAMPLE**: \`enum EventCallback<T> { void Function(T data); }\` is COMPLETELY WRONG. The correct conversion is \`typedef EventCallback<T> = void Function(T data);\`
- All type definitions MUST be included in the output

## Dart Reserved Keywords
These TypeScript identifiers must be renamed in Dart (they are reserved keywords):
- \`default\` → \`defaultValue\` or \`defaults\`
- \`class\` → \`clazz\` or \`className\`
- \`new\` → \`create\` or \`newInstance\`
- \`switch\` → \`switchCase\`
- \`case\` → \`caseValue\`
- \`in\` → \`inValue\`
- \`is\` → \`isValue\`
- \`abstract\` → \`abstractValue\`
- \`as\` → \`asValue\`
- \`assert\` → \`assertValue\`
- \`async\` → \`asyncValue\`
- \`await\` → \`awaitValue\`
- \`break\` → \`breakValue\`
- \`catch\` → \`catchValue\`
- \`const\` → \`constValue\`
- \`continue\` → \`continueValue\`
- \`do\` → \`doValue\`
- \`else\` → \`elseValue\`
- \`enum\` → \`enumValue\`
- \`extends\` → \`extendsValue\`
- \`extension\` → \`extensionValue\`
- \`external\` → \`externalValue\`
- \`factory\` → \`factoryValue\`
- \`false\` → \`falseValue\`
- \`final\` → \`finalValue\`
- \`finally\` → \`finallyValue\`
- \`for\` → \`forValue\`
- \`Function\` → \`FunctionType\` or \`Func\`
- \`get\` → \`getValue\`
- \`if\` → \`ifValue\`
- \`implements\` → \`implementsValue\`
- \`import\` → \`importValue\`
- \`interface\` → \`interfaceValue\`
- \`late\` → \`lateValue\`
- \`library\` → \`libraryValue\`
- \`mixin\` → \`mixinValue\`
- \`null\` → \`nullValue\`
- \`on\` → \`onValue\`
- \`operator\` → \`operatorValue\`
- \`part\` → \`partValue\`
- \`required\` → \`requiredValue\`
- \`rethrow\` → \`rethrowValue\`
- \`return\` → \`returnValue\`
- \`set\` → \`setValue\`
- \`static\` → \`staticValue\`
- \`super\` → \`superValue\`
- \`sync\` → \`syncValue\`
- \`this\` → \`thisValue\`
- \`throw\` → \`throwValue\`
- \`true\` → \`trueValue\`
- \`try\` → \`tryValue\`
- \`typedef\` → \`typedefValue\`
- \`var\` → \`varValue\`
- \`void\` → \`voidValue\`
- \`while\` → \`whileValue\`
- \`with\` → \`withValue\`
- \`yield\` → \`yieldValue\`

## Source Code (${file.relativePath})
\`\`\`${this.sourceLanguage}
${file.content}
\`\`\`

## Ported Code
Provide ONLY the ported code in ${this.targetLanguage}, wrapped in a code block. 

**BEFORE YOU START - ANALYZE THE SOURCE CODE**:
1. Read the source code above carefully
2. **MANDATORY: Create a checklist** - Write down (mentally or on paper) ALL definitions you find:
   - Every \`export enum\` statement → must become a Dart enum
   - Every \`export interface\` statement → must become a Dart class
   - Every \`export type\` statement → must become a Dart typedef or class
   - Every \`interface\` statement (even if NOT exported) → must become a Dart class
   - Every \`export class\` statement → must become a Dart class
   - Every method in classes (both public and private) → must be included
3. **Before submitting your answer, verify** - Check that EVERY item from your checklist appears in your output. If you find any missing, add them before submitting.

**CRITICAL REQUIREMENTS - YOU MUST INCLUDE ALL DEFINITIONS**:
1. **MANDATORY: Include ALL exports from the source file**:
   - If the source file has \`export enum\`, you MUST include the converted enum
   - If the source file has \`export interface\`, you MUST include the converted class (Dart does not have interfaces, convert to class)
   - If the source file has \`export type\`, you MUST include the converted typedef (for functions) or class (for objects) - **NEVER convert type to enum**
   - If the source file has \`export class\`, you MUST include the converted class
   - If the source file has \`export function\`, you MUST include the converted function
   - **DO NOT skip any exported definitions**
   - **CRITICAL: Even non-exported interfaces/types used in the file MUST be included** (e.g., \`interface EventListener\` even if not exported)
   - **CRITICAL: Include ALL methods in classes, including private methods** - If a class has \`private addListener(...)\`, you MUST include it as \`void _addListener(...)\` in Dart. Do NOT skip private methods.
   - **VERIFICATION STEP**: Before finishing, count all \`interface\`, \`type\`, \`enum\`, \`class\` definitions AND all methods (including private) in the source code. Make sure ALL of them appear in your output.
   - **CRITICAL CHECKLIST - Your output MUST include ALL of these**:
     * ✅ All \`export enum\` statements → converted to Dart enum
     * ✅ All \`export interface\` statements → converted to Dart class
     * ✅ All \`export type\` statements → converted to Dart typedef (for functions) or class (for objects)
     * ✅ All \`interface\` statements (even non-exported) → converted to Dart class
     * ✅ All \`export class\` statements → converted to Dart class with ALL methods (public AND private)
   - **DO NOT prioritize methods over definitions** - Include BOTH all definitions (enum, interface, type, class) AND all methods. They are equally important.

2. **Code Quality**:
   - Do NOT include any example code or comments from the instructions above
   - Do NOT include comments like "// TypeScript - ..." or "// Dart - ..."
   - Do NOT include comments like "// Ported from ..." or "// Enums" or "// Interfaces/Types" or "// Classes" or "// Functions"
   - Do NOT add section dividers or organizational comments - just write the code directly
   - Do NOT include reference examples - only generate the actual ported code for the source file
   - Include only the actual ported code with appropriate comments for the code itself (if needed)
   - Do not include explanations or example code blocks
   - **CRITICAL: Maintain the exact structure from source** - If methods are inside a class in the source, they MUST be inside the class in the output. Do NOT extract class methods as top-level functions.

3. **Order of Definitions** (apply naturally, do NOT add section comments):
   - Enums first (if any) - but NO "// Enums" comment
   - Interfaces/Types next (if any) - but NO "// Interfaces/Types" comment
   - Classes last - but NO "// Classes" comment
   - Functions only if they are top-level exports (not class methods) - but NO "// Functions" comment`;
    if (this.promptMode === 'reduced') {
      return this.buildReducedPrompt(file, importContext, sourceFeatures, targetFeatures);
    }

    return fullPrompt;
  }

  private buildReducedPrompt(
    file: SourceFile,
    importContext: string,
    sourceFeatures: string,
    targetFeatures: string
  ): string {
    return `You are an expert software engineer performing a 1:1 code port from ${this.sourceLanguage} to ${this.targetLanguage}.

## Task
Convert the following ${this.sourceLanguage} code to idiomatic ${this.targetLanguage} code while preserving:
- Exact functionality and behavior
- Code structure and organization
- Function/method signatures
- Comments and documentation
- **CRITICAL: Include ALL methods, including private methods**
- **CRITICAL: Do NOT add organizational comments**

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
7. **CRITICAL: NEVER import the current file itself**
8. **CRITICAL: Keep all definitions in the same file**
9. **CRITICAL: Include non-exported interfaces/types**
10. **CRITICAL: Do NOT convert string types to enums**
11. **CRITICAL: Type aliases are NOT enums**
12. **CRITICAL: Include ALL methods, including private methods**

${importContext}

## Source Code
\`\`\`${this.sourceLanguage}
${file.content}
\`\`\`

## Output
Provide ONLY the ported code in ${this.targetLanguage}, wrapped in a code block.`;
  }

  private buildMinimalPrompt(file: SourceFile, options: PortingPromptOptions = {}): string {
    const importContext = options.suppressImports ? '' : this.buildImportContext(file);
    const sourceContent = options.overrideContent ?? file.content;
    const chunkNotice = options.chunked
      ? `\nChunk ${options.chunkIndex! + 1} of ${options.totalChunks!}. ${options.suppressImports ? 'Do NOT include imports.' : 'Include imports only if appropriate at top of file.'}\n`
      : '';
    return `Port this ${this.sourceLanguage} code to ${this.targetLanguage}.
Preserve behavior, structure, signatures, and comments.
Include all definitions and methods (including private).
Do not add extra commentary. Output only code in a code block.

${importContext}

${chunkNotice}

Source:
\`\`\`${this.sourceLanguage}
${sourceContent}
\`\`\``;
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

  /**
   * Removes self-import statements from the ported code
   * Self-imports are import statements that reference the current file itself
   */
  private removeSelfImports(content: string, currentFilePath: string): string {
    // Get the base name of the current file (e.g., "calculator.dart" from "src/calculator.dart")
    const currentFileName = path.basename(currentFilePath);
    const currentFileNameWithoutExt = path.basename(currentFilePath, path.extname(currentFilePath));

    // Normalize current file path for comparison (remove leading slash, use forward slashes)
    const normalizedCurrentPath = currentFilePath.replace(/\\/g, '/').replace(/^\//, '');

    // Patterns to match self-imports
    const selfImportPatterns = [
      // Match: import 'package:.../current_file.dart';
      new RegExp(`import\\s+['"]package:[^'"]*${this.escapeRegex(currentFileName)}['"];?\\s*\\n?`, 'g'),
      // Match: import 'package:.../current_file';
      new RegExp(`import\\s+['"]package:[^'"]*${this.escapeRegex(currentFileNameWithoutExt)}['"];?\\s*\\n?`, 'g'),
      // Match: import 'current_file.dart';
      new RegExp(`import\\s+['"]${this.escapeRegex(currentFileName)}['"];?\\s*\\n?`, 'g'),
      // Match: import 'current_file';
      new RegExp(`import\\s+['"]${this.escapeRegex(currentFileNameWithoutExt)}['"];?\\s*\\n?`, 'g'),
      // Match: import 'package:.../exact/path/to/current_file.dart';
      new RegExp(`import\\s+['"]package:[^'"]*${this.escapeRegex(normalizedCurrentPath)}['"];?\\s*\\n?`, 'g'),
    ];

    let cleanedContent = content;
    for (const pattern of selfImportPatterns) {
      cleanedContent = cleanedContent.replace(pattern, '');
    }

    return cleanedContent.trim();
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Removes import statements that reference files that don't exist in the target project
   * This prevents imports like 'package:ts_sample_dart/enums.dart' when enums.dart doesn't exist
   */
  private removeInvalidImports(content: string, currentFilePath: string): string {
    // Get all valid target file paths from the mapping
    const validTargetPaths = new Set<string>();
    for (const targetPath of this.importMapping.sourcePathToTargetPath.values()) {
      const normalized = targetPath.replace(/\\/g, '/');
      validTargetPaths.add(normalized);
      if (this.targetLanguage === 'dart' && normalized.startsWith('lib/')) {
        validTargetPaths.add(normalized.slice(4));
      }
      // Also add basename for relative imports
      validTargetPaths.add(path.basename(targetPath));
    }

    // Match all import statements
    const importRegex = /import\s+['"]([^'"]+)['"];?\s*\n?/g;
    let cleanedContent = content;
    const matches: Array<{ fullMatch: string; importPath: string }> = [];
    let match;

    // Collect all matches first
    while ((match = importRegex.exec(content)) !== null) {
      matches.push({ fullMatch: match[0], importPath: match[1] });
    }

    // Check and remove invalid imports
    for (const { fullMatch, importPath } of matches) {
      let isValid = false;

      // For package imports, extract the file path
      if (importPath.startsWith('package:')) {
        const packageMatch = importPath.match(/package:([^/]+)\/(.+)/);
        if (packageMatch) {
          const packageName = packageMatch[1];
          const filePath = packageMatch[2].replace(/\\/g, '/');

          // Check if this file exists in our mapping
          let matchesInternal = false;
          for (const targetPath of validTargetPaths) {
            const normalizedTarget = targetPath.replace(/\\/g, '/');
            if (normalizedTarget === filePath ||
              normalizedTarget.endsWith('/' + filePath) ||
              normalizedTarget === filePath.replace(/\.dart$/, '') + '.dart') {
              matchesInternal = true;
              break;
            }
          }

          if (matchesInternal) {
            // Internal files must use the project package name
            isValid = packageName === this.projectName;
          } else {
            // External package import - keep (dependency may be added later)
            isValid = true;
          }
        }
      } else {
        // Relative import - check if resolved path exists
        const currentDir = path.dirname(currentFilePath).replace(/\\/g, '/');
        const resolvedPath = path.normalize(
          path.join(currentDir, importPath)
        ).replace(/\\/g, '/');

        for (const targetPath of validTargetPaths) {
          const normalizedTarget = targetPath.replace(/\\/g, '/');
          if (normalizedTarget === resolvedPath ||
            normalizedTarget.endsWith('/' + path.basename(importPath))) {
            isValid = true;
            break;
          }
        }
      }

      if (!isValid) {
        // Remove invalid import
        cleanedContent = cleanedContent.replace(fullMatch, '');
        if (this.verbose) {
          console.warn(`Removed invalid import: ${importPath} (file does not exist in target project)`);
        }
      }
    }

    return cleanedContent.trim();
  }

  finalizeImportsForTarget(content: string, currentFilePath: string): string {
    return this.removeInvalidImports(content, currentFilePath);
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

    if (this.targetLanguage === 'dart') {
      let updatedPath = filePath;

      if (updatedPath.startsWith('src/')) {
        updatedPath = 'lib/' + updatedPath.slice(4);
      } else if (updatedPath.startsWith('src\\')) {
        updatedPath = 'lib/' + updatedPath.slice(4);
      }

      if (['javascript', 'typescript'].includes(this.sourceLanguage)) {
        // Convert camelCase to snake_case for Dart (Dart convention for file names)
        updatedPath = updatedPath.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      }

      return updatedPath;
    }

    return filePath;
  }

  private stripDartLibPrefix(filePath: string): string {
    if (this.targetLanguage !== 'dart') {
      return filePath;
    }

    if (filePath.startsWith('lib/')) {
      return filePath.slice(4);
    }
    if (filePath.startsWith('lib\\')) {
      return filePath.slice(4);
    }

    return filePath;
  }

  private buildDartImportStatement(targetPath: string, currentTargetPath: string): string {
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    const normalizedCurrent = currentTargetPath.replace(/\\/g, '/');

    if (normalizedTarget.startsWith('lib/') && normalizedCurrent.startsWith('lib/')) {
      const currentDir = path.posix.dirname(normalizedCurrent);
      const relative = path.posix.relative(currentDir, normalizedTarget);
      const normalizedRelative = relative === '' ? path.posix.basename(normalizedTarget) : relative;
      return `import '${normalizedRelative}';`;
    }

    const packagePath = this.stripDartLibPrefix(normalizedTarget);
    return `import 'package:${this.projectName}/${packagePath}';`;
  }

  private enforceDartRequiredNamedParams(content: string): string {
    let updatedContent = content;
    const classRegex = /\bclass\s+([A-Za-z_]\w*)\s*{/g;
    const matches: Array<{ name: string; start: number; bodyStart: number; bodyEnd: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      const bodyStart = match.index + match[0].length;
      let depth = 1;
      let i = bodyStart;
      while (i < content.length && depth > 0) {
        const char = content[i];
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
        }
        i += 1;
      }
      if (depth === 0) {
        matches.push({ name, start: match.index, bodyStart, bodyEnd: i - 1 });
      }
    }

    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const { name, bodyStart, bodyEnd } = matches[index];
      const classBody = updatedContent.slice(bodyStart, bodyEnd);
      const requiredFields = this.collectNonNullableFinalFields(classBody);
      if (requiredFields.size === 0) {
        continue;
      }

      const updatedBody = this.fixDartConstructors(classBody, name, requiredFields);
      updatedContent = updatedContent.slice(0, bodyStart) + updatedBody + updatedContent.slice(bodyEnd);
    }

    return updatedContent;
  }

  private collectNonNullableFinalFields(classBody: string): Set<string> {
    const requiredFields = new Set<string>();
    const fieldRegex = /\b(?:late\s+)?final\s+([A-Za-z0-9_<>,\s?]+)\s+([A-Za-z_]\w*)\s*;/g;
    let match: RegExpExecArray | null;

    while ((match = fieldRegex.exec(classBody)) !== null) {
      const type = match[1].trim();
      const name = match[2];
      if (!type.includes('?')) {
        requiredFields.add(name);
      }
    }

    return requiredFields;
  }

  private fixDartConstructors(
    classBody: string,
    className: string,
    requiredFields: Set<string>
  ): string {
    const constructorRegex = new RegExp(
      `\\b(?:const\\s+)?(?:factory\\s+)?${className}(?:\\s*\\.\\s*[A-Za-z_]\\w*)?\\s*\\(`,
      'g'
    );
    const matches: Array<{ startIndex: number; endIndex: number; content: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = constructorRegex.exec(classBody)) !== null) {
      const startIndex = match.index + match[0].length;
      const parsed = this.parseParenthesesBlock(classBody, startIndex - 1);
      if (!parsed) {
        continue;
      }

      matches.push({
        startIndex,
        endIndex: parsed.endIndex,
        content: parsed.content,
      });
    }

    let updatedBody = classBody;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const { startIndex, endIndex, content } = matches[i];
      const fixedParams = this.fixNamedParams(content, requiredFields);
      if (fixedParams === content) {
        continue;
      }

      updatedBody =
        updatedBody.slice(0, startIndex) +
        fixedParams +
        updatedBody.slice(endIndex);
    }

    return updatedBody;
  }

  private parseParenthesesBlock(
    source: string,
    openParenIndex: number
  ): { content: string; endIndex: number } | null {
    if (source[openParenIndex] !== '(') {
      return null;
    }

    let depth = 0;
    let i = openParenIndex;
    let inString: "'" | '"' | null = null;

    while (i < source.length) {
      const char = source[i];
      if (inString) {
        if (char === inString && source[i - 1] !== '\\') {
          inString = null;
        }
      } else if (char === '"' || char === "'") {
        inString = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          return {
            content: source.slice(openParenIndex + 1, i),
            endIndex: i,
          };
        }
      }
      i += 1;
    }

    return null;
  }

  private fixNamedParams(params: string, requiredFields: Set<string>): string {
    const namedBlock = this.extractNamedParamBlock(params);
    if (!namedBlock) {
      return params;
    }

    const { startIndex, endIndex, content } = namedBlock;
    const parts = this.splitTopLevelParams(content);
    const updatedParts = parts.map((part) =>
      this.ensureRequiredOnParam(part, requiredFields)
    );
    const updatedNamed = updatedParts.join(', ');

    return params.slice(0, startIndex) + updatedNamed + params.slice(endIndex);
  }

  private extractNamedParamBlock(params: string): { startIndex: number; endIndex: number; content: string } | null {
    let depth = 0;
    let startIndex = -1;
    for (let i = 0; i < params.length; i += 1) {
      const char = params[i];
      if (char === '{') {
        if (depth === 0) {
          startIndex = i + 1;
        }
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0 && startIndex !== -1) {
          return {
            startIndex,
            endIndex: i,
            content: params.slice(startIndex, i),
          };
        }
      }
    }

    return null;
  }

  private splitTopLevelParams(content: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depthParen = 0;
    let depthAngle = 0;
    let depthSquare = 0;
    let depthBrace = 0;
    let inString: "'" | '"' | null = null;

    for (let i = 0; i < content.length; i += 1) {
      const char = content[i];
      if (inString) {
        current += char;
        if (char === inString && content[i - 1] !== '\\') {
          inString = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = char;
        current += char;
        continue;
      }

      if (char === '(') depthParen += 1;
      if (char === ')') depthParen -= 1;
      if (char === '<') depthAngle += 1;
      if (char === '>') depthAngle = Math.max(0, depthAngle - 1);
      if (char === '[') depthSquare += 1;
      if (char === ']') depthSquare -= 1;
      if (char === '{') depthBrace += 1;
      if (char === '}') depthBrace -= 1;

      if (
        char === ',' &&
        depthParen === 0 &&
        depthAngle === 0 &&
        depthSquare === 0 &&
        depthBrace === 0
      ) {
        if (current.trim() !== '') {
          parts.push(current.trim());
        }
        current = '';
        continue;
      }

      current += char;
    }

    if (current.trim() !== '') {
      parts.push(current.trim());
    }

    return parts;
  }

  private enforceDartExportedConstNames(content: string, file: SourceFile): string {
    let updatedContent = content;
    const constExports = file.exports.filter(symbol => symbol.type === 'const');

    for (const symbol of constExports) {
      const name = symbol.name;
      if (updatedContent.includes(name)) {
        continue;
      }

      if (name === name.toUpperCase()) {
        const lower = name.toLowerCase();
        const declRegex = new RegExp(`\\b(const|final|var)\\s+${this.escapeRegex(lower)}\\b`);
        updatedContent = updatedContent.replace(declRegex, `$1 ${name}`);
      }
    }

    return updatedContent;
  }

  private ensureDartRequiredImports(content: string, file: SourceFile): string {
    const imports = this.extractSourceImports(file.content);
    if (imports.length === 0) {
      return content;
    }

    const targetPath = this.convertFilePath(file.relativePath);
    const currentDir = path.dirname(targetPath).replace(/\\/g, '/');
    const requiredImports = new Set<string>();

    for (const imp of imports) {
      const resolved = this.resolveImportPath(imp.path, file.relativePath);
      let importStatement: string;

      if (resolved) {
        importStatement = this.buildDartImportStatement(resolved, targetPath);
      } else {
        const resolvedSourcePath = path.normalize(
          path.join(path.dirname(file.relativePath), imp.path)
            .replace(/\.(ts|js|tsx|jsx)$/, '')
        ).replace(/\\/g, '/');
        const dartPath = this.transformPath(this.toSnakeCase(resolvedSourcePath) + '.dart');
        importStatement = this.buildDartImportStatement(dartPath, targetPath);
      }

      requiredImports.add(importStatement);
    }

    if (requiredImports.size === 0) {
      return content;
    }

    const lines = content.split('\n');
    const existingImports = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ')) {
        existingImports.add(trimmed);
      }
    }

    const missing = Array.from(requiredImports).filter(statement => !existingImports.has(statement));
    if (missing.length === 0) {
      return content;
    }

    let insertAt = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (
        trimmed.startsWith('library ') ||
        trimmed.startsWith('part of ') ||
        trimmed.startsWith('part ') ||
        trimmed.startsWith('import ') ||
        trimmed.startsWith('export ')
      ) {
        insertAt = i + 1;
        continue;
      }
      if (trimmed !== '') {
        break;
      }
    }

    const updatedLines = [
      ...lines.slice(0, insertAt),
      ...missing,
      '',
      ...lines.slice(insertAt),
    ];

    return updatedLines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  private normalizeDartImports(content: string, file: SourceFile): string {
    const imports = this.extractSourceImports(file.content);
    if (imports.length === 0) {
      return content;
    }

    const targetPath = this.convertFilePath(file.relativePath);
    const requiredImports = new Set<string>();

    for (const imp of imports) {
      const resolved = this.resolveImportPath(imp.path, file.relativePath);
      let importStatement: string;

      if (resolved) {
        importStatement = this.buildDartImportStatement(resolved, targetPath);
      } else {
        const resolvedSourcePath = path.normalize(
          path.join(path.dirname(file.relativePath), imp.path)
            .replace(/\.(ts|js|tsx|jsx)$/, '')
        ).replace(/\\/g, '/');
        const dartPath = this.transformPath(this.toSnakeCase(resolvedSourcePath) + '.dart');
        importStatement = this.buildDartImportStatement(dartPath, targetPath);
      }

      requiredImports.add(importStatement);
    }

    const lines = content.split('\n');
    const keptLines: string[] = [];
    let insertAt = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('import ')) {
        continue;
      }
      if (
        trimmed.startsWith('library ') ||
        trimmed.startsWith('part of ') ||
        trimmed.startsWith('part ') ||
        trimmed.startsWith('export ')
      ) {
        keptLines.push(lines[i]);
        insertAt = keptLines.length;
        continue;
      }
      keptLines.push(lines[i]);
    }

    const normalizedImports = Array.from(requiredImports);
    if (normalizedImports.length === 0) {
      return keptLines.join('\n');
    }

    const updatedLines = [
      ...keptLines.slice(0, insertAt),
      ...normalizedImports,
      '',
      ...keptLines.slice(insertAt),
    ];

    return updatedLines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  private extractSourceImports(content: string): Array<{ path: string; symbols: string[] }> {
    const importRegex = /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    const imports: Array<{ path: string; symbols: string[] }> = [];
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      const symbolMatch = match[0].match(/import\s+\{([^}]+)\}/);
      const symbols = symbolMatch
        ? symbolMatch[1].split(',').map(s => s.trim().split(' as ')[0].trim())
        : [];
      imports.push({ path: importPath, symbols });
    }

    return imports;
  }

  private getRequiredDartImports(file: SourceFile, targetPath: string): string[] {
    const imports = this.extractSourceImports(file.content);
    const requiredImports = new Set<string>();

    for (const imp of imports) {
      const resolved = this.resolveImportPath(imp.path, file.relativePath);
      let importStatement: string;

      if (resolved) {
        importStatement = this.buildDartImportStatement(resolved, targetPath);
      } else {
        const resolvedSourcePath = path.normalize(
          path.join(path.dirname(file.relativePath), imp.path)
            .replace(/\.(ts|js|tsx|jsx)$/, '')
        ).replace(/\\/g, '/');
        const dartPath = this.transformPath(this.toSnakeCase(resolvedSourcePath) + '.dart');
        importStatement = this.buildDartImportStatement(dartPath, targetPath);
      }

      requiredImports.add(importStatement);
    }

    return Array.from(requiredImports);
  }

  private extractDartImportLines(content: string): string[] {
    const lines = content.split('\n');
    return lines
      .map(line => line.trim())
      .filter(line => line.startsWith('import '))
      .map(line => (line.endsWith(';') ? line : `${line};`));
  }

  private validateDartImports(
    content: string,
    file: SourceFile,
    targetPath: string
  ): { issues: string[]; requiredImports: string[]; actualImports: string[] } {
    const issues: string[] = [];
    const requiredImports = this.getRequiredDartImports(file, targetPath);
    const actualImports = this.extractDartImportLines(content);

    for (const required of requiredImports) {
      if (!actualImports.includes(required)) {
        issues.push(`Missing import: ${required}`);
      }
    }

    for (const actual of actualImports) {
      const packageMatch = actual.match(/import\s+['"]package:([^/]+)\//);
      if (packageMatch && packageMatch[1] !== this.projectName) {
        issues.push(`Invalid package import: ${actual}`);
      }
    }

    return { issues, requiredImports, actualImports };
  }

  private ensureRequiredOnParam(part: string, requiredFields: Set<string>): string {
    const trimmed = part.trim();
    if (
      trimmed === '' ||
      /\brequired\b/.test(trimmed) ||
      /@required\b/i.test(trimmed) ||
      trimmed.includes('=')
    ) {
      return part;
    }

    let fieldName: string | null = null;
    const thisMatch = /\bthis\.([A-Za-z_]\w*)\b/.exec(trimmed);
    if (thisMatch) {
      fieldName = thisMatch[1];
    } else {
      const bareMatch = /\b([A-Za-z_]\w*)\b\s*$/.exec(trimmed);
      if (bareMatch) {
        fieldName = bareMatch[1];
      }
    }

    if (!fieldName || !requiredFields.has(fieldName)) {
      return part;
    }

    if (trimmed.includes('?')) {
      return part;
    }

    return `required ${trimmed}`;
  }
}
