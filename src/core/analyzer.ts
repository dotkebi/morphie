import { glob } from 'glob';
import { FileSystem } from '../utils/filesystem.js';
import { detectLanguage, getFileExtensions, FileType } from '../utils/languages.js';
import path from 'path';

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  type: FileType;
  exports: ExportedSymbol[];
}

export interface ExportedSymbol {
  name: string;
  type: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'variable';
  isDefault: boolean;
  /** Parent class/namespace if this is a nested type (e.g., "Stave" for "Stave.Position") */
  parentClass?: string;
  /** Fully qualified name including parent (e.g., "Stave.Position" or "Position") */
  qualifiedName: string;
}

export interface ProjectAnalysis {
  language: string;
  files: SourceFile[];
  entryPoints: string[];
  dependencies: string[];
  structure: ProjectStructure;
}

export interface ProjectStructure {
  hasTests: boolean;
  hasConfig: boolean;
  hasDocs: boolean;
  directories: string[];
}

export class ProjectAnalyzer {
  private fs: FileSystem;
  private sourcePath: string;
  private specifiedLanguage?: string;

  constructor(sourcePath: string, specifiedLanguage?: string) {
    this.sourcePath = path.resolve(sourcePath);
    this.specifiedLanguage = specifiedLanguage;
    this.fs = new FileSystem();
  }

  async analyze(): Promise<ProjectAnalysis> {
    const language = this.specifiedLanguage || await this.detectProjectLanguage();
    const extensions = getFileExtensions(language);
    const files = await this.collectFiles(extensions);
    const entryPoints = this.findEntryPoints(files, language);
    const dependencies = await this.extractDependencies(language);
    const structure = await this.analyzeStructure();

    return {
      language,
      files,
      entryPoints,
      dependencies,
      structure,
    };
  }

  private async detectProjectLanguage(): Promise<string> {
    const files = await glob('**/*', {
      cwd: this.sourcePath,
      nodir: true,
      ignore: ['node_modules/**', '.git/**', '__pycache__/**', 'target/**', 'dist/**'],
    });

    const extensionCounts: Record<string, number> = {};

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext) {
        extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
      }
    }

    return detectLanguage(extensionCounts);
  }

  private async collectFiles(extensions: string[]): Promise<SourceFile[]> {
    const patterns = extensions.map(ext => `**/*${ext}`);
    const files: SourceFile[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.sourcePath,
        nodir: true,
        ignore: [
          'node_modules/**',
          '.git/**',
          '__pycache__/**',
          'target/**',
          'dist/**',
          'build/**',
          '.venv/**',
          'venv/**',
          '**/*.d.ts',  // TypeScript declaration files
          '**/*.test.ts',
          '**/*.spec.ts',
          '**/*.test.js',
          '**/*.spec.js',
        ],
      });

      for (const match of matches) {
        const absolutePath = path.join(this.sourcePath, match);
        const content = await this.fs.readFile(absolutePath);
        const type = this.classifyFile(match);
        const exports = this.extractExports(content);

        files.push({
          absolutePath,
          relativePath: match,
          content,
          type,
          exports,
        });
      }
    }

    return files;
  }

  private extractExports(content: string): ExportedSymbol[] {
    const symbols: ExportedSymbol[] = [];
    const language = this.specifiedLanguage || 'typescript';

    if (language === 'typescript' || language === 'javascript') {
      let match;

      // First, find all exported classes and their positions
      const classRegex = /export\s+(?:abstract\s+)?class\s+(\w+)/g;
      const classPositions: Array<{ name: string; start: number; end: number }> = [];

      while ((match = classRegex.exec(content)) !== null) {
        const className = match[1];
        const classStart = match.index;
        const classEnd = this.findClassEnd(content, classStart);
        classPositions.push({ name: className, start: classStart, end: classEnd });
        symbols.push({
          name: className,
          type: 'class',
          isDefault: false,
          qualifiedName: className,
        });
      }

      // Export default class
      const defaultClassRegex = /export\s+default\s+class\s+(\w+)/g;
      while ((match = defaultClassRegex.exec(content)) !== null) {
        const className = match[1];
        const classStart = match.index;
        const classEnd = this.findClassEnd(content, classStart);
        classPositions.push({ name: className, start: classStart, end: classEnd });
        symbols.push({
          name: className,
          type: 'class',
          isDefault: true,
          qualifiedName: className,
        });
      }

      // Find static enums/types inside classes (e.g., static Position = { ... } or static enum Position)
      for (const classInfo of classPositions) {
        const classContent = content.slice(classInfo.start, classInfo.end);

        // Static enum-like objects: static Position = { LEFT: 1, RIGHT: 2 }
        const staticEnumRegex = /static\s+(\w+)\s*=\s*\{/g;
        while ((match = staticEnumRegex.exec(classContent)) !== null) {
          const enumName = match[1];
          // Skip common non-enum static properties
          if (['DEBUG', 'CATEGORY', 'TEXT_FONT'].includes(enumName)) continue;
          symbols.push({
            name: enumName,
            type: 'enum',
            isDefault: false,
            parentClass: classInfo.name,
            qualifiedName: `${classInfo.name}.${enumName}`,
          });
        }

        // Static readonly enum-like: static readonly Position = { ... }
        const staticReadonlyRegex = /static\s+readonly\s+(\w+)\s*=\s*\{/g;
        while ((match = staticReadonlyRegex.exec(classContent)) !== null) {
          const enumName = match[1];
          symbols.push({
            name: enumName,
            type: 'enum',
            isDefault: false,
            parentClass: classInfo.name,
            qualifiedName: `${classInfo.name}.${enumName}`,
          });
        }
      }

      // Export interface
      const interfaceRegex = /export\s+interface\s+(\w+)/g;
      while ((match = interfaceRegex.exec(content)) !== null) {
        symbols.push({
          name: match[1],
          type: 'interface',
          isDefault: false,
          qualifiedName: match[1],
        });
      }

      // Export type
      const typeRegex = /export\s+type\s+(\w+)/g;
      while ((match = typeRegex.exec(content)) !== null) {
        symbols.push({
          name: match[1],
          type: 'type',
          isDefault: false,
          qualifiedName: match[1],
        });
      }

      // Export enum (top-level)
      const enumRegex = /export\s+(?:const\s+)?enum\s+(\w+)/g;
      while ((match = enumRegex.exec(content)) !== null) {
        // Check if this enum is inside a class
        const enumPos = match.index;
        const parentClass = classPositions.find(
          c => enumPos > c.start && enumPos < c.end
        );

        if (parentClass) {
          symbols.push({
            name: match[1],
            type: 'enum',
            isDefault: false,
            parentClass: parentClass.name,
            qualifiedName: `${parentClass.name}.${match[1]}`,
          });
        } else {
          symbols.push({
            name: match[1],
            type: 'enum',
            isDefault: false,
            qualifiedName: match[1],
          });
        }
      }

      // Export function
      const functionRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
      while ((match = functionRegex.exec(content)) !== null) {
        symbols.push({
          name: match[1],
          type: 'function',
          isDefault: false,
          qualifiedName: match[1],
        });
      }

      // Export const/let/var
      const constRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
      while ((match = constRegex.exec(content)) !== null) {
        symbols.push({
          name: match[1],
          type: 'const',
          isDefault: false,
          qualifiedName: match[1],
        });
      }
    }

    return symbols;
  }

  private findClassEnd(content: string, startPos: number): number {
    // Find the opening brace of the class
    const bracePos = content.indexOf('{', startPos);
    if (bracePos === -1) return content.length;

    let depth = 1;
    let pos = bracePos + 1;

    while (pos < content.length && depth > 0) {
      const char = content[pos];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      pos++;
    }

    return pos;
  }

  private classifyFile(filePath: string): FileType {
    const lowerPath = filePath.toLowerCase();
    const fileName = path.basename(lowerPath);

    // Barrel files (re-export files)
    if (fileName === 'index.ts' || fileName === 'index.js' || fileName === 'index.mjs') {
      return 'barrel';
    }
    if (lowerPath.includes('test') || lowerPath.includes('spec')) {
      return 'test';
    }
    if (lowerPath.includes('config') || lowerPath.endsWith('.config.js') || lowerPath.endsWith('.config.ts')) {
      return 'config';
    }
    if (lowerPath.includes('util') || lowerPath.includes('helper')) {
      return 'utility';
    }
    if (lowerPath.includes('model') || lowerPath.includes('schema') || lowerPath.includes('entity')) {
      return 'model';
    }
    if (lowerPath.includes('service') || lowerPath.includes('api')) {
      return 'service';
    }

    return 'source';
  }

  private findEntryPoints(files: SourceFile[], language: string): string[] {
    const entryPatterns: Record<string, string[]> = {
      python: ['main.py', '__main__.py', 'app.py', 'cli.py'],
      javascript: ['index.js', 'main.js', 'app.js', 'cli.js'],
      typescript: ['index.ts', 'main.ts', 'app.ts', 'cli.ts'],
      go: ['main.go', 'cmd/main.go'],
      rust: ['main.rs', 'lib.rs'],
      java: ['Main.java', 'App.java', 'Application.java'],
    };

    const patterns = entryPatterns[language] || [];
    return files
      .filter(f => patterns.some(p => f.relativePath.endsWith(p)))
      .map(f => f.relativePath);
  }

  private async extractDependencies(language: string): Promise<string[]> {
    const depFiles: Record<string, string> = {
      python: 'requirements.txt',
      javascript: 'package.json',
      typescript: 'package.json',
      go: 'go.mod',
      rust: 'Cargo.toml',
      java: 'pom.xml',
    };

    const depFile = depFiles[language];
    if (!depFile) return [];

    const depPath = path.join(this.sourcePath, depFile);
    if (!(await this.fs.fileExists(depPath))) return [];

    const content = await this.fs.readFile(depPath);
    return this.parseDependencies(content, language);
  }

  private parseDependencies(content: string, language: string): string[] {
    switch (language) {
      case 'python':
        return content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
          .map(line => line.split('==')[0].split('>=')[0].split('~=')[0]);

      case 'javascript':
      case 'typescript':
        try {
          const pkg = JSON.parse(content);
          return [
            ...Object.keys(pkg.dependencies || {}),
            ...Object.keys(pkg.devDependencies || {}),
          ];
        } catch {
          return [];
        }

      default:
        return [];
    }
  }

  private async analyzeStructure(): Promise<ProjectStructure> {
    const allFiles = await glob('**/*', {
      cwd: this.sourcePath,
      nodir: true,
      ignore: ['node_modules/**', '.git/**'],
    });

    const directories = [...new Set(allFiles.map(f => path.dirname(f)))].filter(d => d !== '.');

    return {
      hasTests: allFiles.some(f => f.toLowerCase().includes('test')),
      hasConfig: allFiles.some(f => f.includes('config') || f.includes('.env')),
      hasDocs: allFiles.some(f => f.endsWith('.md') || f.includes('docs/')),
      directories,
    };
  }
}
