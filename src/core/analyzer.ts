import { glob } from 'glob';
import { FileSystem } from '../utils/filesystem.js';
import { detectLanguage, getFileExtensions, FileType } from '../utils/languages.js';
import path from 'path';
import ts from 'typescript';

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
  dependencyGraph: FileDependencyGraph;
}

export interface FileDependencyGraph {
  // File -> local dependency files (same project, relative path keys)
  edges: Record<string, string[]>;
}

export interface ProjectStructure {
  hasTests: boolean;
  hasConfig: boolean;
  hasDocs: boolean;
  directories: string[];
}

// ── AST-based export extractor (TypeScript / JavaScript only) ─────────────────

function extractExportsWithAST(content: string, filePath: string): ExportedSymbol[] {
  const isTs = /\.(ts|tsx)$/.test(filePath);
  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : isTs
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind
  );

  const symbols: ExportedSymbol[] = [];

  // Collect top-level class ranges so we can detect nested static members
  const classRanges: Array<{ name: string; pos: number; end: number }> = [];

  function classifyConst(initializer: ts.Expression | undefined): ExportedSymbol['type'] {
    if (!initializer) return 'const';
    if (
      ts.isArrowFunction(initializer) ||
      ts.isFunctionExpression(initializer)
    ) return 'function';
    return 'const';
  }

  function visitTopLevel(node: ts.Node): void {
    // export class Foo / export abstract class Foo / export default class Foo
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      hasExportModifier(node)
    ) {
      const name = node.name.text;
      const isDefault = hasDefaultModifier(node);
      classRanges.push({ name, pos: node.pos, end: node.end });
      symbols.push({ name, type: 'class', isDefault, qualifiedName: name });

      // Collect static enum-like members inside the class
      collectStaticEnumMembers(node, name, symbols);
      return;
    }

    // export interface Foo
    if (ts.isInterfaceDeclaration(node) && node.name && hasExportModifier(node)) {
      const name = node.name.text;
      symbols.push({ name, type: 'interface', isDefault: false, qualifiedName: name });
      return;
    }

    // export type Foo = ...
    if (ts.isTypeAliasDeclaration(node) && node.name && hasExportModifier(node)) {
      const name = node.name.text;
      symbols.push({ name, type: 'type', isDefault: false, qualifiedName: name });
      return;
    }

    // export enum Foo / export const enum Foo
    if (ts.isEnumDeclaration(node) && node.name && hasExportModifier(node)) {
      const name = node.name.text;
      const parentClass = classRanges.find(c => node.pos > c.pos && node.pos < c.end);
      if (parentClass) {
        symbols.push({
          name,
          type: 'enum',
          isDefault: false,
          parentClass: parentClass.name,
          qualifiedName: `${parentClass.name}.${name}`,
        });
      } else {
        symbols.push({ name, type: 'enum', isDefault: false, qualifiedName: name });
      }
      return;
    }

    // export function foo / export async function foo
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
      const name = node.name?.text ?? 'default';
      const isDefault = hasDefaultModifier(node) || name === 'default';
      symbols.push({ name, type: 'function', isDefault, qualifiedName: name });
      return;
    }

    // export const / let / var foo = ...
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      const isDefault = hasDefaultModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const symbolType = classifyConst(decl.initializer);
          symbols.push({ name, type: symbolType, isDefault, qualifiedName: name });
        }
      }
      return;
    }

    // export default expr / export default class (anonymous)
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        // export default Foo  — Foo is already collected above as named export
        // mark it as default too
        const existing = symbols.find(s => s.name === expr.text);
        if (existing) {
          existing.isDefault = true;
        } else {
          symbols.push({ name: expr.text, type: 'variable', isDefault: true, qualifiedName: expr.text });
        }
      } else if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
        symbols.push({ name: 'default', type: 'function', isDefault: true, qualifiedName: 'default' });
      } else if (ts.isClassExpression(expr)) {
        const name = expr.name?.text ?? 'default';
        symbols.push({ name, type: 'class', isDefault: true, qualifiedName: name });
      }
      return;
    }

    // export { Foo, Bar as Baz } [from '...']
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const specifier of node.exportClause.elements) {
          const exportedName = (specifier.name ?? specifier.propertyName)?.text;
          if (!exportedName) continue;
          // We can't know the type without resolving the module; use 'variable' as fallback
          if (!symbols.find(s => s.name === exportedName)) {
            symbols.push({ name: exportedName, type: 'variable', isDefault: false, qualifiedName: exportedName });
          }
        }
      }
      return;
    }

    // export namespace / module Foo { ... }  — collect nested exports
    if (
      (ts.isModuleDeclaration(node) || ts.isNamespaceExportDeclaration(node)) &&
      hasExportModifier(node as ts.Node)
    ) {
      const nameNode = (node as ts.ModuleDeclaration).name;
      if (nameNode && ts.isIdentifier(nameNode)) {
        const nsName = nameNode.text;
        const body = (node as ts.ModuleDeclaration).body;
        if (body && ts.isModuleBlock(body)) {
          for (const stmt of body.statements) {
            if (hasExportModifier(stmt)) {
              const nestedName = getDeclarationName(stmt);
              if (nestedName) {
                symbols.push({
                  name: nestedName,
                  type: getDeclarationKind(stmt),
                  isDefault: false,
                  parentClass: nsName,
                  qualifiedName: `${nsName}.${nestedName}`,
                });
              }
            }
          }
        }
      }
    }
  }

  // Only visit top-level statements
  for (const stmt of sourceFile.statements) {
    visitTopLevel(stmt);
  }

  return symbols;
}

function collectStaticEnumMembers(
  classNode: ts.ClassDeclaration,
  className: string,
  symbols: ExportedSymbol[]
): void {
  const skipNames = new Set(['DEBUG', 'CATEGORY', 'TEXT_FONT']);

  for (const member of classNode.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !member.name ||
      !ts.isIdentifier(member.name)
    ) continue;

    const isStatic = member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
    if (!isStatic) continue;

    const name = member.name.text;
    if (skipNames.has(name)) continue;

    // Static property initialized with object literal → enum-like
    if (member.initializer && ts.isObjectLiteralExpression(member.initializer)) {
      symbols.push({
        name,
        type: 'enum',
        isDefault: false,
        parentClass: className,
        qualifiedName: `${className}.${name}`,
      });
    }
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    (ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) ??
    false
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    (ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) ??
    false
  );
}

function getDeclarationName(node: ts.Statement): string | undefined {
  if (ts.isClassDeclaration(node)) return node.name?.text;
  if (ts.isInterfaceDeclaration(node)) return node.name?.text;
  if (ts.isTypeAliasDeclaration(node)) return node.name?.text;
  if (ts.isEnumDeclaration(node)) return node.name?.text;
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  if (ts.isVariableStatement(node)) {
    const first = node.declarationList.declarations[0];
    return ts.isIdentifier(first?.name) ? first.name.text : undefined;
  }
  return undefined;
}

function getDeclarationKind(node: ts.Statement): ExportedSymbol['type'] {
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isFunctionDeclaration(node)) return 'function';
  return 'const';
}

// ── Import extractor (AST-based) ──────────────────────────────────────────────

function extractLocalImportsWithAST(content: string, filePath: string): string[] {
  const isTs = /\.(ts|tsx|js|jsx)$/.test(filePath);
  if (!isTs) return extractLocalImportsFallback(content);

  const scriptKind = filePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : filePath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : filePath.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const imports = new Set<string>();

  function visit(node: ts.Node): void {
    // import ... from './foo'
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        imports.add(specifier.text);
      }
    }
    // export { ... } from './foo'  /  export * from './foo'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        imports.add(specifier.text);
      }
    }
    // require('./foo')
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) && arg.text.startsWith('.')) {
        imports.add(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return Array.from(imports);
}

function extractLocalImportsFallback(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1].startsWith('.')) imports.add(match[1]);
    }
  }
  return Array.from(imports);
}

// ── ProjectAnalyzer ───────────────────────────────────────────────────────────

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
    const files = await this.collectFiles(extensions, language);
    const entryPoints = this.findEntryPoints(files, language);
    const dependencies = await this.extractDependencies(language);
    const structure = await this.analyzeStructure();
    const dependencyGraph = this.buildDependencyGraph(files, language);

    return { language, files, entryPoints, dependencies, structure, dependencyGraph };
  }

  private buildDependencyGraph(files: SourceFile[], language: string): FileDependencyGraph {
    const edges: Record<string, string[]> = {};
    const lang = language.toLowerCase();
    const isScript = lang === 'typescript' || lang === 'javascript';

    const fileSet = new Set(files.map(f => f.relativePath.replace(/\\/g, '/')));
    for (const file of files) {
      const filePath = file.relativePath.replace(/\\/g, '/');
      edges[filePath] = [];
      if (!isScript) continue;

      const imports = extractLocalImportsWithAST(file.content, filePath);
      for (const importPath of imports) {
        const resolved = this.resolveLocalImport(importPath, filePath, fileSet);
        if (!resolved || resolved === filePath) continue;
        if (!edges[filePath].includes(resolved)) {
          edges[filePath].push(resolved);
        }
      }
    }
    return { edges };
  }

  private resolveLocalImport(importPath: string, fromFile: string, fileSet: Set<string>): string | null {
    const fromDir = path.posix.dirname(fromFile);
    const base = path.posix.normalize(path.posix.join(fromDir, importPath));
    const candidates = [
      base,
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
      path.posix.join(base, 'index.ts'),
      path.posix.join(base, 'index.tsx'),
      path.posix.join(base, 'index.js'),
      path.posix.join(base, 'index.jsx'),
    ];
    for (const candidate of candidates) {
      if (fileSet.has(candidate)) return candidate;
    }
    return null;
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
      if (ext) extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
    }

    return detectLanguage(extensionCounts);
  }

  private async collectFiles(extensions: string[], language: string): Promise<SourceFile[]> {
    const patterns = extensions.map(ext => `**/*${ext}`);
    const files: SourceFile[] = [];
    const useAST = language === 'typescript' || language === 'javascript';

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.sourcePath,
        nodir: true,
        ignore: [
          'node_modules/**', '.git/**', '__pycache__/**',
          'target/**', 'dist/**', 'build/**', '.venv/**', 'venv/**',
          '**/*.d.ts',
          '**/*.test.ts', '**/*.spec.ts',
          '**/*.test.js', '**/*.spec.js',
        ],
      });

      for (const match of matches) {
        const absolutePath = path.join(this.sourcePath, match);
        const content = await this.fs.readFile(absolutePath);
        const type = this.classifyFile(match, content);
        const exports = useAST
          ? extractExportsWithAST(content, match)
          : this.extractExportsFallback(content);

        files.push({ absolutePath, relativePath: match, content, type, exports });
      }
    }

    return files;
  }

  /** Fallback regex extractor for non-TS/JS languages */
  private extractExportsFallback(content: string): ExportedSymbol[] {
    return [];
  }

  private classifyFile(filePath: string, content: string): FileType {
    const lowerPath = filePath.toLowerCase();
    const fileName = path.basename(lowerPath);

    if (
      (fileName === 'index.ts' || fileName === 'index.js' || fileName === 'index.mjs') &&
      this.isBarrelFile(content)
    ) {
      return 'barrel';
    }
    if (lowerPath.includes('test') || lowerPath.includes('spec')) return 'test';
    if (lowerPath.includes('config') || lowerPath.endsWith('.config.js') || lowerPath.endsWith('.config.ts')) return 'config';
    if (lowerPath.includes('util') || lowerPath.includes('helper')) return 'utility';
    if (lowerPath.includes('model') || lowerPath.includes('schema') || lowerPath.includes('entity')) return 'model';
    if (lowerPath.includes('service') || lowerPath.includes('api')) return 'service';
    return 'source';
  }

  private isBarrelFile(content: string): boolean {
    const stripped = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'));

    if (stripped.length === 0) return false;
    if (/export\s+(?:class|interface|type|enum|function|const|let|var)\b/.test(content)) return false;

    const exportFromRegex = /^export\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"]\s*;?$/;
    const exportListRegex = /^export\s+\{[^}]*\}\s*;?$/;
    return stripped.every(line => exportFromRegex.test(line) || exportListRegex.test(line));
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
          const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
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
