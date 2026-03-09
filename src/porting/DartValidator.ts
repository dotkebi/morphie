import type { SourceFile } from '../core/analyzer.js';

export class DartValidator {
  private projectName: string;

  constructor(projectName: string) {
    this.projectName = projectName;
  }

  validateSyntaxHeuristics(content: string): string[] {
    const issues: string[] = [];
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      issues.push('empty output');
      return issues;
    }

    const balanceTarget = this.stripCommentsAndStringsForBalance(trimmed);
    const count = (char: string): number => (balanceTarget.match(new RegExp(`\\${char}`, 'g')) ?? []).length;
    if (count('{') !== count('}')) issues.push('unbalanced braces');
    if (count('(') !== count(')')) issues.push('unbalanced parentheses');
    if (count('[') !== count(']')) issues.push('unbalanced brackets');

    if (/^\s*import\s+.+\s+from\s+['"][^'"]+['"];?\s*$/m.test(trimmed)) {
      issues.push('contains JavaScript import-from syntax');
    }
    if (/^\s*export\s+default\b/m.test(trimmed)) {
      issues.push('contains export default syntax');
    }
    if (/\bmodule\.exports\b/.test(trimmed)) {
      issues.push('contains module.exports');
    }
    if (/\brequire\s*\(/.test(trimmed)) {
      issues.push('contains require()');
    }

    return issues;
  }

  validateSemanticHeuristics(content: string): string[] {
    const issues: string[] = [];
    issues.push(...this.findDuplicateTopLevelDeclarations(content));
    const semanticTarget = this.stripCommentsAndStringsForBalance(content);

    if (/(^|[^.\w])pow\s*\(/.test(semanticTarget) && !/^\s*import\s+['"]dart:math['"]/m.test(content)) {
      issues.push('pow() used without dart:math import');
    }

    if (/\bint\s+\w+\s*=\s*VoiceMode\./.test(semanticTarget)) {
      issues.push('VoiceMode assigned to int');
    }
    if (
      /\bstatic\s+(?:[A-Za-z_]\w*\s+)?get\s+mode\b/.test(semanticTarget) &&
      /\b(?:late\s+)?(?:final\s+)?[A-Za-z_]\w*\s+mode\s*=/.test(semanticTarget)
    ) {
      issues.push('static/instance member name conflict: mode');
    }

    return issues;
  }

  validateContractHeuristics(content: string, sourcePath: string): string[] {
    const issues: string[] = [];
    const coreContracts: Record<string, string[]> = {
      'src/fraction.ts': ['add', 'subtract', 'value', 'clone', 'simplify'],
      'src/tickable.ts': ['getTicks', 'shouldIgnoreTicks', 'setVoice', 'setContext', 'drawWithStyle'],
      'src/element.ts': ['setRendered', 'checkContext', 'getBoundingBox', 'setContext'],
    };

    const required = coreContracts[sourcePath];
    if (!required) return issues;

    const className = sourcePath.endsWith('fraction.ts')
      ? 'Fraction'
      : sourcePath.endsWith('tickable.ts')
        ? 'Tickable'
        : 'Element';

    const classBody = this.extractDartClassBody(content, className);
    if (!classBody) {
      issues.push(`missing class ${className}`);
      return issues;
    }

    for (const method of required) {
      const methodPattern = new RegExp(`\\b${this.escapeRegex(method)}\\s*\\(`);
      if (!methodPattern.test(classBody)) {
        issues.push(`${className}.${method} missing`);
      }
    }

    return issues;
  }

  validateImports(
    content: string,
    file: SourceFile,
    targetPath: string,
    requiredImports: string[]
  ): { issues: string[]; requiredImports: string[]; actualImports: string[] } {
    const issues: string[] = [];
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

  validateFinalChunkedOutput(content: string, sourcePath: string): string[] {
    const issues: string[] = [];
    issues.push(...this.validateSyntaxHeuristics(content));
    issues.push(...this.validateSemanticHeuristics(content));
    issues.push(...this.validateContractHeuristics(content, sourcePath));
    return Array.from(new Set(issues));
  }

  private extractDartImportLines(content: string): string[] {
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('import '))
      .map(line => (line.endsWith(';') ? line : `${line};`));
  }

  private findDuplicateTopLevelDeclarations(content: string): string[] {
    const issues: string[] = [];
    const declarationRegex = /^\s*(?:(?:abstract|interface|sealed|base|final)\s+)*(class|enum|typedef|mixin)\s+([A-Za-z_]\w*)\b/gm;
    const seen = new Map<string, string>();
    let match: RegExpExecArray | null;
    while ((match = declarationRegex.exec(content)) !== null) {
      const kind = match[1];
      const name = match[2];
      const existing = seen.get(name);
      if (existing) {
        issues.push(`duplicate declaration: ${name} (${existing}/${kind})`);
      } else {
        seen.set(name, kind);
      }
    }
    return issues;
  }

  private extractDartClassBody(content: string, className: string): string | null {
    const classRegex = new RegExp(`\\b(?:abstract\\s+)?class\\s+${this.escapeRegex(className)}\\b[^\\{]*\\{`, 'g');
    const match = classRegex.exec(content);
    if (!match) return null;
    const openBrace = content.indexOf('{', match.index);
    if (openBrace < 0) return null;
    const closeBrace = this.findMatchingBrace(content, openBrace);
    if (closeBrace < 0) return null;
    return content.slice(openBrace + 1, closeBrace);
  }

  stripCommentsAndStringsForBalance(source: string): string {
    let result = '';
    let i = 0;
    let inLineComment = false;
    let inBlockComment = false;
    let inString: "'" | '"' | '`' | null = null;

    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];

      if (inLineComment) {
        if (ch === '\n') { inLineComment = false; result += '\n'; }
        i += 1;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
        if (ch === '\n') result += '\n';
        i += 1;
        continue;
      }
      if (inString) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inString) inString = null;
        i += 1;
        continue;
      }

      if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch as "'" | '"' | '`'; i += 1; continue; }

      result += ch;
      i += 1;
    }

    return result;
  }

  findMatchingBrace(source: string, openBraceIndex: number): number {
    let depth = 0;
    let inString: '"' | "'" | null = null;
    for (let i = openBraceIndex; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (ch === inString && source[i - 1] !== '\\') inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = ch; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  }

  escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
