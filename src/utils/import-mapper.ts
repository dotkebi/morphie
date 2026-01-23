import path from 'path';

export interface ExportedSymbol {
  name: string;
  type: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'variable';
  isDefault: boolean;
}

export interface FileExports {
  relativePath: string;
  targetPath: string;
  symbols: ExportedSymbol[];
}

export interface ImportMapping {
  files: FileExports[];
  symbolToFile: Map<string, string>;
}

export class ImportMapper {
  private sourceLanguage: string;
  private targetLanguage: string;
  private projectName: string;

  constructor(sourceLanguage: string, targetLanguage: string, projectName: string) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.projectName = this.toSnakeCase(projectName);
  }

  buildMapping(files: Array<{ relativePath: string; content: string }>): ImportMapping {
    const fileExports: FileExports[] = [];
    const symbolToFile = new Map<string, string>();

    for (const file of files) {
      const targetPath = this.convertToTargetPath(file.relativePath);
      const symbols = this.extractExports(file.content, this.sourceLanguage);

      fileExports.push({
        relativePath: file.relativePath,
        targetPath,
        symbols,
      });

      // Map each symbol to its target file path
      for (const symbol of symbols) {
        symbolToFile.set(symbol.name, targetPath);
      }
    }

    return { files: fileExports, symbolToFile };
  }

  private extractExports(content: string, language: string): ExportedSymbol[] {
    const symbols: ExportedSymbol[] = [];

    if (language === 'typescript' || language === 'javascript') {
      symbols.push(...this.extractTypeScriptExports(content));
    } else if (language === 'python') {
      symbols.push(...this.extractPythonExports(content));
    }

    return symbols;
  }

  private extractTypeScriptExports(content: string): ExportedSymbol[] {
    const symbols: ExportedSymbol[] = [];

    // Export class
    const classRegex = /export\s+(?:abstract\s+)?class\s+(\w+)/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'class', isDefault: false });
    }

    // Export default class
    const defaultClassRegex = /export\s+default\s+class\s+(\w+)/g;
    while ((match = defaultClassRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'class', isDefault: true });
    }

    // Export interface
    const interfaceRegex = /export\s+interface\s+(\w+)/g;
    while ((match = interfaceRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'interface', isDefault: false });
    }

    // Export type
    const typeRegex = /export\s+type\s+(\w+)/g;
    while ((match = typeRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'type', isDefault: false });
    }

    // Export enum
    const enumRegex = /export\s+(?:const\s+)?enum\s+(\w+)/g;
    while ((match = enumRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'enum', isDefault: false });
    }

    // Export function
    const functionRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
    while ((match = functionRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'function', isDefault: false });
    }

    // Export const/let/var
    const constRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
    while ((match = constRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'const', isDefault: false });
    }

    return symbols;
  }

  private extractPythonExports(content: string): ExportedSymbol[] {
    const symbols: ExportedSymbol[] = [];

    // Class definitions
    const classRegex = /^class\s+(\w+)/gm;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      symbols.push({ name: match[1], type: 'class', isDefault: false });
    }

    // Function definitions (top level)
    const funcRegex = /^def\s+(\w+)/gm;
    while ((match = funcRegex.exec(content)) !== null) {
      if (!match[1].startsWith('_')) {
        symbols.push({ name: match[1], type: 'function', isDefault: false });
      }
    }

    return symbols;
  }

  private convertToTargetPath(sourcePath: string): string {
    const ext = path.extname(sourcePath);
    let basePath = sourcePath.slice(0, -ext.length);

    if (this.targetLanguage === 'dart') {
      // Convert to snake_case and add .dart extension
      basePath = this.toSnakeCase(basePath);
      return basePath + '.dart';
    }

    return basePath + this.getTargetExtension();
  }

  private getTargetExtension(): string {
    const extensions: Record<string, string> = {
      dart: '.dart',
      python: '.py',
      go: '.go',
      rust: '.rs',
      java: '.java',
      kotlin: '.kt',
    };
    return extensions[this.targetLanguage] || '.txt';
  }

  private toSnakeCase(str: string): string {
    return str
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[-\s]/g, '_')
      .toLowerCase();
  }

  generateImportContext(mapping: ImportMapping): string {
    if (this.targetLanguage !== 'dart') {
      return '';
    }

    const lines: string[] = [
      '## Import Path Mapping (CRITICAL - Use these exact paths)',
      `Package name: ${this.projectName}`,
      '',
      'When importing symbols, use these exact import paths:',
      '',
    ];

    // Group by directory for better readability
    const byDir = new Map<string, FileExports[]>();
    for (const file of mapping.files) {
      const dir = path.dirname(file.targetPath);
      if (!byDir.has(dir)) {
        byDir.set(dir, []);
      }
      byDir.get(dir)!.push(file);
    }

    for (const [dir, files] of byDir) {
      lines.push(`### ${dir || 'root'}/`);
      for (const file of files) {
        if (file.symbols.length > 0) {
          const symbolNames = file.symbols.map(s => s.name).join(', ');
          lines.push(`- \`import 'package:${this.projectName}/${file.targetPath}';\` → ${symbolNames}`);
        }
      }
      lines.push('');
    }

    lines.push('### Import Rules:');
    lines.push('1. Use package imports for project files: `import \'package:' + this.projectName + '/path/to/file.dart\';`');
    lines.push('2. Use relative imports ONLY for files in the same directory: `import \'file.dart\';`');
    lines.push('3. NEVER use `import \'package:source_measure/...\';` or other made-up package names');
    lines.push('4. File paths use snake_case in Dart');
    lines.push('');

    return lines.join('\n');
  }

  convertTsImportToDart(
    tsImportPath: string,
    currentFilePath: string
  ): string {
    // Remove ./ and extension
    let importPath = tsImportPath
      .replace(/^\.\//, '')
      .replace(/\.(ts|js|tsx|jsx)$/, '');

    // Convert to snake_case
    importPath = this.toSnakeCase(importPath);

    // Resolve relative path
    const currentDir = path.dirname(currentFilePath);
    const resolvedPath = path.join(currentDir, importPath + '.dart');
    const normalizedPath = path.normalize(resolvedPath).replace(/\\/g, '/');

    // Check if it's in the same directory
    if (path.dirname(normalizedPath) === this.toSnakeCase(currentDir)) {
      return `'${path.basename(normalizedPath)}'`;
    }

    // Use package import
    return `'package:${this.projectName}/${normalizedPath}'`;
  }
}
