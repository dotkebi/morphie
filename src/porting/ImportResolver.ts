import path from 'path';
import type { SourceFile, ExportedSymbol } from '../core/analyzer.js';

export interface SymbolLocation {
  filePath: string;
  symbol: ExportedSymbol;
}

export interface ImportMapping {
  symbolToFile: Map<string, string>;
  qualifiedNameToLocation: Map<string, SymbolLocation>;
  fileToSymbols: Map<string, ExportedSymbol[]>;
  simpleNameToLocations: Map<string, SymbolLocation[]>;
  sourcePathToTargetPath: Map<string, string>;
}

export class ImportResolver {
  private projectName: string;
  private targetLanguage: string;
  private verbose: boolean;
  readonly mapping: ImportMapping;

  constructor(projectName: string, targetLanguage: string, verbose = false) {
    this.projectName = projectName;
    this.targetLanguage = targetLanguage;
    this.verbose = verbose;
    this.mapping = {
      symbolToFile: new Map(),
      qualifiedNameToLocation: new Map(),
      fileToSymbols: new Map(),
      simpleNameToLocations: new Map(),
      sourcePathToTargetPath: new Map(),
    };
  }

  buildMapping(files: SourceFile[], convertFilePath: (p: string) => string): void {
    for (const file of files) {
      const targetPath = convertFilePath(file.relativePath);
      this.mapping.sourcePathToTargetPath.set(file.relativePath, targetPath);
      this.mapping.fileToSymbols.set(targetPath, file.exports);

      for (const symbol of file.exports) {
        const location: SymbolLocation = { filePath: targetPath, symbol };
        this.mapping.qualifiedNameToLocation.set(symbol.qualifiedName ?? symbol.name, location);
        this.mapping.symbolToFile.set(symbol.name, targetPath);

        if (!this.mapping.simpleNameToLocations.has(symbol.name)) {
          this.mapping.simpleNameToLocations.set(symbol.name, []);
        }
        this.mapping.simpleNameToLocations.get(symbol.name)!.push(location);
      }
    }
  }

  resolveImportPath(importPath: string, fromSourcePath: string): string | null {
    const sourceDir = path.dirname(fromSourcePath);
    let resolvedSourcePath = path.normalize(path.join(sourceDir, importPath)).replace(/\\/g, '/');

    const fromSourceWithoutExt = fromSourcePath.replace(/\.(ts|js|tsx|jsx)$/, '');
    const resolvedWithoutExt = resolvedSourcePath.replace(/\.(ts|js|tsx|jsx)$/, '');

    if (resolvedWithoutExt === fromSourceWithoutExt || resolvedSourcePath === fromSourcePath) return null;

    if (this.mapping.sourcePathToTargetPath.has(resolvedSourcePath)) {
      return this.mapping.sourcePathToTargetPath.get(resolvedSourcePath)!;
    }

    for (const [sourcePath, targetPath] of this.mapping.sourcePathToTargetPath) {
      const sourceWithoutExt = sourcePath.replace(/\.(ts|js|tsx|jsx)$/, '');
      if (sourceWithoutExt === resolvedWithoutExt) return targetPath;
    }

    const indexPaths = [
      resolvedWithoutExt + '/index.ts',
      resolvedWithoutExt + '/index.js',
      resolvedWithoutExt + '/index.tsx',
      resolvedWithoutExt + '/index.jsx',
    ];
    for (const indexPath of indexPaths) {
      if (this.mapping.sourcePathToTargetPath.has(indexPath)) {
        return this.mapping.sourcePathToTargetPath.get(indexPath)!;
      }
    }

    for (const [sourcePath, targetPath] of this.mapping.sourcePathToTargetPath) {
      const sourcePathDir = path.dirname(sourcePath).replace(/\\/g, '/');
      const sourcePathBase = path.basename(sourcePath, path.extname(sourcePath));
      if (
        sourcePathDir === resolvedWithoutExt &&
        (sourcePathBase === 'index' || sourcePathBase === resolvedWithoutExt.split('/').pop())
      ) {
        return targetPath;
      }
    }

    const resolvedDir = resolvedWithoutExt;
    for (const [sourcePath, targetPath] of this.mapping.sourcePathToTargetPath) {
      const sourcePathDir = path.dirname(sourcePath).replace(/\\/g, '/');
      if (sourcePathDir === resolvedDir) {
        const targetDir = path.dirname(targetPath).replace(/\\/g, '/');
        const possibleIndex = targetDir + '/index.dart';
        if (this.mapping.fileToSymbols.has(possibleIndex)) return possibleIndex;
        if (this.verbose) {
          console.warn(`Warning: No index file found for directory ${resolvedDir}, using ${targetPath}`);
        }
        return targetPath;
      }
    }

    return null;
  }

  buildDartImportStatement(targetPath: string, currentTargetPath: string): string {
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

  getRequiredDartImports(file: SourceFile, targetPath: string): string[] {
    const imports = this.extractSourceImports(file.content);
    const requiredImports = new Set<string>();

    for (const imp of imports) {
      const resolved = this.resolveImportPath(imp.path, file.relativePath);
      let importStatement: string;

      if (resolved) {
        importStatement = this.buildDartImportStatement(resolved, targetPath);
      } else {
        const resolvedSourcePath = path.normalize(
          path.join(path.dirname(file.relativePath), imp.path).replace(/\.(ts|js|tsx|jsx)$/, '')
        ).replace(/\\/g, '/');
        const dartPath = this.transformPath(this.toSnakeCase(resolvedSourcePath) + '.dart');
        importStatement = this.buildDartImportStatement(dartPath, targetPath);
      }

      requiredImports.add(importStatement);
    }

    return Array.from(requiredImports);
  }

  removeSelfImports(content: string, currentFilePath: string): string {
    const currentFileName = path.basename(currentFilePath);
    const currentFileNameWithoutExt = path.basename(currentFilePath, path.extname(currentFilePath));
    const normalizedCurrentPath = currentFilePath.replace(/\\/g, '/').replace(/^\//, '');

    const selfImportPatterns = [
      new RegExp(`import\\s+['"]package:[^'"]*${this.escapeRegex(currentFileName)}['"];?\\s*\\n?`, 'g'),
      new RegExp(`import\\s+['"]package:[^'"]*${this.escapeRegex(currentFileNameWithoutExt)}['"];?\\s*\\n?`, 'g'),
      new RegExp(`import\\s+['"]${this.escapeRegex(currentFileName)}['"];?\\s*\\n?`, 'g'),
      new RegExp(`import\\s+['"]${this.escapeRegex(currentFileNameWithoutExt)}['"];?\\s*\\n?`, 'g'),
      new RegExp(`import\\s+['"]package:[^'"]*${this.escapeRegex(normalizedCurrentPath)}['"];?\\s*\\n?`, 'g'),
    ];

    let cleanedContent = content;
    for (const pattern of selfImportPatterns) {
      cleanedContent = cleanedContent.replace(pattern, '');
    }
    return cleanedContent.trim();
  }

  removeInvalidImports(content: string, currentFilePath: string): string {
    const validTargetPaths = new Set<string>();
    for (const targetPath of this.mapping.sourcePathToTargetPath.values()) {
      const normalized = targetPath.replace(/\\/g, '/');
      validTargetPaths.add(normalized);
      if (this.targetLanguage === 'dart' && normalized.startsWith('lib/')) {
        validTargetPaths.add(normalized.slice(4));
      }
      validTargetPaths.add(path.basename(targetPath));
    }

    const importRegex = /import\s+['"]([^'"]+)['"];?\s*\n?/g;
    let cleanedContent = content;
    const matches: Array<{ fullMatch: string; importPath: string }> = [];
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      matches.push({ fullMatch: match[0], importPath: match[1] });
    }

    for (const { fullMatch, importPath } of matches) {
      let isValid = false;

      if (importPath.startsWith('dart:')) {
        isValid = true;
      } else if (importPath.startsWith('package:')) {
        const packageMatch = importPath.match(/package:([^/]+)\/(.+)/);
        if (packageMatch) {
          const packageName = packageMatch[1];
          const filePath = packageMatch[2].replace(/\\/g, '/');
          let matchesInternal = false;
          for (const targetPath of validTargetPaths) {
            const normalizedTarget = targetPath.replace(/\\/g, '/');
            if (
              normalizedTarget === filePath ||
              normalizedTarget.endsWith('/' + filePath) ||
              normalizedTarget === filePath.replace(/\.dart$/, '') + '.dart'
            ) {
              matchesInternal = true;
              break;
            }
          }
          isValid = matchesInternal ? packageName === this.projectName : true;
        }
      } else {
        const currentDir = path.dirname(currentFilePath).replace(/\\/g, '/');
        const resolvedPath = path.normalize(path.join(currentDir, importPath)).replace(/\\/g, '/');
        for (const targetPath of validTargetPaths) {
          const normalizedTarget = targetPath.replace(/\\/g, '/');
          if (
            normalizedTarget === resolvedPath ||
            normalizedTarget.endsWith('/' + path.basename(importPath))
          ) {
            isValid = true;
            break;
          }
        }
      }

      if (!isValid) {
        cleanedContent = cleanedContent.replace(fullMatch, '');
        if (this.verbose) {
          console.warn(`Removed invalid import: ${importPath} (file does not exist in target project)`);
        }
      }
    }

    return cleanedContent.trim();
  }

  extractSourceImports(content: string): Array<{ path: string; symbols: string[] }> {
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

  findNestedTypesInFile(file: SourceFile, currentTargetPath: string): ExportedSymbol[] {
    const symbols = this.mapping.fileToSymbols.get(currentTargetPath) || [];
    return symbols.filter(s => s.parentClass);
  }

  findAmbiguousSymbols(file: SourceFile): Array<{ name: string; locations: SymbolLocation[] }> {
    const result: Array<{ name: string; locations: SymbolLocation[] }> = [];
    for (const [name, locations] of this.mapping.simpleNameToLocations) {
      if (locations.length > 1 && file.content.includes(name)) {
        result.push({ name, locations });
      }
    }
    return result.slice(0, 10);
  }

  private stripDartLibPrefix(filePath: string): string {
    if (this.targetLanguage !== 'dart') return filePath;
    if (filePath.startsWith('lib/') || filePath.startsWith('lib\\')) return filePath.slice(4);
    return filePath;
  }

  private transformPath(filePath: string): string {
    if (this.targetLanguage === 'dart') {
      let updatedPath = filePath;
      if (updatedPath.startsWith('src/') || updatedPath.startsWith('src\\')) {
        updatedPath = 'lib/' + updatedPath.slice(4);
      }
      return updatedPath;
    }
    return filePath;
  }

  toSnakeCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]/g, '_').toLowerCase();
  }

  escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
