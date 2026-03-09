import path from 'path';
import type { SourceFile } from '../core/analyzer.js';
import { DartValidator } from './DartValidator.js';

export class DartPostProcessor {
  private projectName: string;
  private validator: DartValidator;

  constructor(projectName: string) {
    this.projectName = projectName;
    this.validator = new DartValidator(projectName);
  }

  sanitizeModuleSyntax(content: string): string {
    const lines = content.split('\n');
    const directives: string[] = [];
    const body: string[] = [];

    const normalizeDirective = (raw: string): string | null => {
      const line = raw.trim();
      if (line.length === 0) return null;

      const jsImportFrom = line.match(/^import\s+.+\s+from\s+['"]([^'"]+)['"];?$/);
      if (jsImportFrom) return `import '${jsImportFrom[1]}';`;

      const jsExportFrom = line.match(/^export\s+.+\s+from\s+['"]([^'"]+)['"];?$/);
      if (jsExportFrom) return `export '${jsExportFrom[1]}';`;

      if (/^\s*(import|export|part|library)\b/.test(line)) {
        let normalized = line.replace(/\sas\s+default\b/g, ' as default_');
        if (!normalized.endsWith(';')) normalized = `${normalized};`;

        if (/^(import|export|part)\s+['"][^'"]+['"](?:\s+as\s+[A-Za-z_]\w*)?;?$/.test(normalized)) return normalized;
        if (/^library\s+[A-Za-z_][\w.]*;?$/.test(normalized)) return normalized;
      }

      return null;
    };

    for (const line of lines) {
      const normalizedDirective = normalizeDirective(line);
      if (normalizedDirective) {
        directives.push(normalizedDirective);
      } else {
        body.push(line);
      }
    }

    const uniqueDirectives = Array.from(new Set(directives));
    const trimmedBody = body.join('\n').replace(/^\s+/, '');

    if (uniqueDirectives.length === 0) return content;

    return `${uniqueDirectives.join('\n')}\n\n${trimmedBody}`.replace(/\n{3,}/g, '\n\n').trim();
  }

  repairDelimiterBalance(content: string, appendMissingClosers: boolean): string {
    if (!content.trim()) return content;

    const removeIndexes = new Set<number>();
    const openerToCloser: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
    const closerToOpener: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
    const stack: Array<{ char: string; index: number }> = [];
    let i = 0;
    let inLineComment = false;
    let inBlockComment = false;
    let inString: "'" | '"' | '`' | null = null;

    while (i < content.length) {
      const ch = content[i];
      const next = content[i + 1];

      if (inLineComment) { if (ch === '\n') inLineComment = false; i += 1; continue; }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
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

      if (ch in openerToCloser) { stack.push({ char: ch, index: i }); i += 1; continue; }
      if (ch in closerToOpener) {
        const expectedOpen = closerToOpener[ch];
        if (stack.length > 0 && stack[stack.length - 1].char === expectedOpen) {
          stack.pop();
        } else {
          removeIndexes.add(i);
        }
      }
      i += 1;
    }

    let updated = content.split('').filter((_char, idx) => !removeIndexes.has(idx)).join('');

    if (appendMissingClosers && stack.length > 0) {
      const suffix = stack.slice().reverse().map(item => openerToCloser[item.char] ?? '').join('');
      if (suffix.length > 0) updated = `${updated}\n${suffix}`;
    }

    return updated.replace(/\n{3,}/g, '\n\n').trim();
  }

  mergeDuplicateClasses(content: string): string {
    const classRegex = /(?:(?:abstract|interface|sealed|base|final|mixin)\s+)*class\s+([A-Za-z_]\w*)[^{]*\{/g;
    type Block = { name: string; start: number; openBrace: number; end: number; header: string; body: string };
    const blocks: Block[] = [];
    let match: RegExpExecArray | null;

    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      const openBrace = content.indexOf('{', match.index);
      if (openBrace < 0) continue;
      const closeBrace = this.validator.findMatchingBrace(content, openBrace);
      if (closeBrace < 0) continue;
      const header = content.slice(match.index, openBrace + 1);
      const body = content.slice(openBrace + 1, closeBrace).trim();
      blocks.push({ name, start: match.index, openBrace, end: closeBrace + 1, header, body });
      classRegex.lastIndex = closeBrace + 1;
    }

    if (blocks.length < 2) return content;

    const byName = new Map<string, Block[]>();
    for (const block of blocks) {
      const list = byName.get(block.name) ?? [];
      list.push(block);
      byName.set(block.name, list);
    }

    const replacementRanges: Array<{ start: number; end: number; replacement: string }> = [];
    for (const duplicates of byName.values()) {
      if (duplicates.length < 2) continue;
      duplicates.sort((a, b) => a.start - b.start);
      const first = duplicates[0];
      const mergedBody = duplicates.map(item => item.body).filter(Boolean).join('\n\n').trim();
      const merged = `${first.header}\n${mergedBody}\n}`;
      replacementRanges.push({ start: first.start, end: first.end, replacement: merged });
      for (let i = 1; i < duplicates.length; i += 1) {
        replacementRanges.push({ start: duplicates[i].start, end: duplicates[i].end, replacement: '' });
      }
    }

    if (replacementRanges.length === 0) return content;
    replacementRanges.sort((a, b) => b.start - a.start);
    let updated = content;
    for (const range of replacementRanges) {
      updated = `${updated.slice(0, range.start)}${range.replacement}${updated.slice(range.end)}`;
    }

    return updated.replace(/\n{3,}/g, '\n\n').trim();
  }

  dedupeTopLevelDeclarations(content: string): string {
    type Range = { start: number; end: number };
    const removal: Range[] = [];
    const seen = new Set<string>();
    const declRegex = /^\s*(?:(?:abstract|interface|sealed|base|final)\s+)*(class|enum|mixin|typedef)\s+([A-Za-z_]\w*)\b/gm;
    let match: RegExpExecArray | null;

    while ((match = declRegex.exec(content)) !== null) {
      const kind = match[1];
      const name = match[2];
      const start = match.index;
      let end = -1;

      if (kind === 'typedef') {
        const semi = content.indexOf(';', declRegex.lastIndex);
        if (semi >= 0) end = semi + 1;
      } else {
        const openBrace = content.indexOf('{', declRegex.lastIndex - 1);
        if (openBrace >= 0) {
          const closeBrace = this.validator.findMatchingBrace(content, openBrace);
          if (closeBrace >= 0) { end = closeBrace + 1; declRegex.lastIndex = end; }
        }
      }

      if (end <= start) continue;
      if (seen.has(name)) {
        removal.push({ start, end });
      } else {
        seen.add(name);
      }
    }

    if (removal.length === 0) return content;

    removal.sort((a, b) => b.start - a.start);
    let updated = content;
    for (const range of removal) {
      updated = `${updated.slice(0, range.start)}\n${updated.slice(range.end)}`;
    }
    return updated.replace(/\n{3,}/g, '\n\n').trim();
  }

  normalizePowUsage(content: string): string {
    return this.ensureDartMathImports(content);
  }

  /**
   * Ensure `dart:math` is imported when math symbols are used.
   *
   * Two cases:
   * 1. `math.xxx` usage (prefixed) → `import 'dart:math' as math;`
   * 2. Bare math function/constant usage (min, max, sqrt, pi, Random, …)
   *    without a `math.` prefix → `import 'dart:math' show <symbols>;`
   *    (merged into an existing dart:math import if present)
   *
   * `pow` without prefix is normalised to `math.pow` first (existing behaviour).
   */
  ensureDartMathImports(content: string): string {
    // Normalise bare `pow(` → `math.pow(` (preserve existing behaviour)
    let updated = content.replace(/(^|[^.\w])pow\s*\(/g, '$1math.pow(');

    const hasMathPrefix = /\bmath\.[a-zA-Z_]/.test(updated);

    // Bare math symbols that are NOT part of `math.xxx` and NOT inside a string
    const mathShowSymbols: Array<{ name: string; pattern: RegExp }> = [
      { name: 'min',    pattern: /(?<![.\w])min\s*\(/ },
      { name: 'max',    pattern: /(?<![.\w])max\s*\(/ },
      { name: 'sqrt',   pattern: /(?<![.\w])sqrt\s*\(/ },
      { name: 'sin',    pattern: /(?<![.\w])sin\s*\(/ },
      { name: 'cos',    pattern: /(?<![.\w])cos\s*\(/ },
      { name: 'tan',    pattern: /(?<![.\w])tan\s*\(/ },
      { name: 'asin',   pattern: /(?<![.\w])asin\s*\(/ },
      { name: 'acos',   pattern: /(?<![.\w])acos\s*\(/ },
      { name: 'atan',   pattern: /(?<![.\w])atan\s*\(/ },
      { name: 'atan2',  pattern: /(?<![.\w])atan2\s*\(/ },
      { name: 'log',    pattern: /(?<![.\w])log\s*\(/ },
      { name: 'exp',    pattern: /(?<![.\w])exp\s*\(/ },
      { name: 'pi',     pattern: /(?<![.\w'"])pi\b/ },
      { name: 'e',      pattern: /(?<![.\w'"])(?<![A-Za-z])e\b(?!\w)/ },
      { name: 'Random', pattern: /(?<![.\w])Random\s*\(/ },
    ];

    // Symbols used bare (not via math. prefix)
    const bareSymbolsNeeded = mathShowSymbols
      .filter(s => s.pattern.test(updated))
      .map(s => s.name);

    const needsMathAs = hasMathPrefix;
    const needsShow = bareSymbolsNeeded.length > 0;

    if (!needsMathAs && !needsShow) return updated;

    // Parse existing dart:math imports
    const asImportRe = /^import\s+['"]dart:math['"]\s+as\s+math\s*;/m;
    const showImportRe = /^import\s+['"]dart:math['"]\s+show\s+([^;]+);/m;
    const plainImportRe = /^import\s+['"]dart:math['"]\s*;/m;

    const hasAsImport = asImportRe.test(updated);
    const showMatch = showImportRe.exec(updated);
    const hasPlain = plainImportRe.test(updated);

    // If `math.` prefix is needed, ensure `as math` import exists
    if (needsMathAs && !hasAsImport) {
      // Remove plain or show-only dart:math imports that would conflict
      if (hasPlain) updated = updated.replace(plainImportRe, "import 'dart:math' as math;");
      else if (showMatch) {
        // Keep show import and add a separate `as math`
        updated = updated.replace(showImportRe, `import 'dart:math' as math;\nimport 'dart:math' show ${showMatch[1].trim()};`);
      } else {
        updated = this.insertDartImport(updated, "import 'dart:math' as math;");
      }
    }

    // If bare symbols are needed, ensure they appear in a show import
    if (needsShow) {
      const currentShow = showImportRe.exec(updated);
      if (hasAsImport || (needsMathAs && asImportRe.test(updated))) {
        // `as math` already covers everything — no separate show needed
      } else if (currentShow) {
        // Merge missing symbols into existing show list
        const existingShown = new Set(currentShow[1].split(',').map(s => s.trim()));
        const toAdd = bareSymbolsNeeded.filter(s => !existingShown.has(s));
        if (toAdd.length > 0) {
          const merged = [...existingShown, ...toAdd].join(', ');
          updated = updated.replace(showImportRe, `import 'dart:math' show ${merged};`);
        }
      } else if (!hasPlain && !asImportRe.test(updated)) {
        updated = this.insertDartImport(updated, `import 'dart:math' show ${bareSymbolsNeeded.join(', ')};`);
      }
      // If plain `import 'dart:math';` already exists, it covers all symbols — no action needed
    }

    return updated.replace(/\n{3,}/g, '\n\n').trim();
  }

  private insertDartImport(content: string, importLine: string): string {
    const lines = content.split('\n');
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
    lines.splice(insertAt, 0, importLine);
    return lines.join('\n');
  }

  normalizeCommonFieldIssues(content: string): string {
    let updated = content;
    updated = updated.replace(
      /\bstatic\s+([A-Za-z_]\w*\s+)?get\s+mode\b/g,
      (_m, typePart = '') => `static ${typePart}get Mode`
    );
    updated = updated.replace(/\bint\s+mode\s*=\s*VoiceMode\./g, 'VoiceMode mode = VoiceMode.');

    const finalFieldRegex = /^\s*final\s+([A-Za-z0-9_<>, ?]+)\s+([A-Za-z_]\w*)\s*;\s*$/gm;
    let match: RegExpExecArray | null;
    const toLate = new Set<string>();
    while ((match = finalFieldRegex.exec(updated)) !== null) {
      const fieldName = match[2];
      const assignRegex = new RegExp(`\\b(?:this\\.)?${this.validator.escapeRegex(fieldName)}\\s*=`, 'g');
      let hitCount = 0;
      while (assignRegex.exec(updated) !== null) {
        hitCount += 1;
        if (hitCount > 1) { toLate.add(fieldName); break; }
      }
    }

    if (toLate.size > 0) {
      updated = updated.replace(finalFieldRegex, (line, typeName: string, fieldName: string) => {
        if (!toLate.has(fieldName)) return line;
        return `late ${typeName.trim()} ${fieldName};`;
      });
    }

    return updated;
  }

  sanitizeTypeScriptResiduals(content: string): string {
    let updated = content;
    updated = updated.replace(
      /^(\s*)(public|protected|private)\s+([A-Za-z_]\w*\s*\()/gm,
      (_m, indent: string, _kw: string, rest: string) => `${indent}${rest}`
    );
    updated = updated.replace(/^(\s*)readonly\s+/gm, '$1');
    updated = updated.replace(/\bexport\s+default\b/g, '');

    // If the content still contains JSON escape sequences (e.g. \n, \", \\), it means
    // the LLM response was a raw JSON-encoded string that wasn't properly decoded.
    // Detect this by checking for a high density of \n or \" sequences and unescape.
    const escapedNewlines = (updated.match(/\\n/g) ?? []).length;
    const escapedQuotes = (updated.match(/\\"/g) ?? []).length;
    const realNewlines = (updated.match(/\n/g) ?? []).length;
    const looksLikeJsonEscaped = escapedNewlines > 5 && escapedNewlines > realNewlines * 2;
    if (looksLikeJsonEscaped || escapedQuotes > 10) {
      updated = updated
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }

    return updated;
  }

  applyAnalyzerHeuristicFixes(content: string): string {
    let updated = content;

    updated = updated.replace(
      /^(\s*)const(\s+[A-Za-z_<>, ?]+\s+[A-Za-z_]\w*\s*=\s*)([^;]+);$/gm,
      (_m, indent: string, lhs: string, rhs: string) => {
        const expr = rhs.trim();
        const likelyNonConst =
          /\bnew\s+/.test(expr) || /\b[A-Za-z_]\w*\s*\(/.test(expr) || /\b[A-Za-z_]\w*\.[A-Za-z_]\w*/.test(expr);
        if (likelyNonConst && !expr.startsWith('const ')) return `${indent}final${lhs}${expr};`;
        return `${indent}const${lhs}${expr};`;
      }
    );

    updated = updated.replace(
      /^(\s*)(?!late\b)(?!static\b)(?!const\b)(?!external\b)(?!factory\b)(?!abstract\b)(final\s+)?([A-Za-z_]\w*(?:<[^>]+>)?\??)\s+([A-Za-z_]\w*)\s*;\s*$/gm,
      (_m, indent: string, finalKw: string | undefined, typeName: string, fieldName: string) => {
        if (typeName.trim().endsWith('?')) return `${indent}${finalKw ?? ''}${typeName} ${fieldName};`;
        return `${indent}late ${typeName} ${fieldName};`;
      }
    );

    return updated;
  }

  narrowImportsByUsage(content: string): string {
    const lines = content.split('\n');
    const usesTables = /\bTables\./.test(content);
    const updated = lines.map(line => {
      const trimmed = line.trim();
      if (!usesTables && /import\s+['"][^'"]*tables\.dart['"]/.test(trimmed)) return '';
      if (usesTables && /import\s+['"][^'"]*tables\.dart['"]/.test(trimmed) && !/\bshow\b/.test(trimmed)) {
        return line.replace(/;?\s*$/, ' show Tables;');
      }
      return line;
    });
    return updated.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  enforceRequiredNamedParams(content: string): string {
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
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        i += 1;
      }
      if (depth === 0) matches.push({ name, start: match.index, bodyStart, bodyEnd: i - 1 });
    }

    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const { name, bodyStart, bodyEnd } = matches[index];
      const classBody = updatedContent.slice(bodyStart, bodyEnd);
      const requiredFields = this.collectNonNullableFinalFields(classBody);
      if (requiredFields.size === 0) continue;
      const updatedBody = this.fixDartConstructors(classBody, name, requiredFields);
      updatedContent = updatedContent.slice(0, bodyStart) + updatedBody + updatedContent.slice(bodyEnd);
    }

    return updatedContent;
  }

  enforceExportedConstNames(content: string, file: SourceFile): string {
    let updatedContent = content;
    const constExports = file.exports.filter(symbol => symbol.type === 'const');

    for (const symbol of constExports) {
      const name = symbol.name;
      if (updatedContent.includes(name)) continue;
      if (name === name.toUpperCase()) {
        const lower = name.toLowerCase();
        const declRegex = new RegExp(`\\b(const|final|var)\\s+${this.validator.escapeRegex(lower)}\\b`);
        updatedContent = updatedContent.replace(declRegex, `$1 ${name}`);
      }
    }

    return updatedContent;
  }

  applyContractStubFallback(
    content: string,
    sourcePath: string,
    issues?: string[]
  ): { content: string; injected: string[] } {
    const contractIssues = (issues ?? this.validator.validateContractHeuristics(content, sourcePath))
      .filter(issue => /^[A-Za-z_]\w*\.[A-Za-z_]\w* missing$/.test(issue));
    if (contractIssues.length === 0) return { content, injected: [] };

    const byClass = new Map<string, Set<string>>();
    for (const issue of contractIssues) {
      const m = issue.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*) missing$/);
      if (!m) continue;
      const className = m[1];
      const method = m[2];
      if (!byClass.has(className)) byClass.set(className, new Set());
      byClass.get(className)!.add(method);
    }

    const ranges: Array<{ start: number; end: number; insert: string; injected: string[] }> = [];
    for (const [className, methods] of byClass.entries()) {
      const classRange = this.findClassRange(content, className);
      if (!classRange) continue;
      const classBody = content.slice(classRange.openBrace + 1, classRange.closeBrace);
      const missing = Array.from(methods).filter(
        method => !new RegExp(`\\b${this.validator.escapeRegex(method)}\\s*\\(`).test(classBody)
      );
      if (missing.length === 0) continue;
      const stubBlock = missing.map(method => this.buildContractStubMethod(method)).join('\n\n');
      ranges.push({
        start: classRange.closeBrace,
        end: classRange.closeBrace,
        insert: `\n\n${stubBlock}\n`,
        injected: missing.map(method => `${className}.${method}`),
      });
    }

    if (ranges.length === 0) return { content, injected: [] };

    ranges.sort((a, b) => b.start - a.start);
    let updated = content;
    const injected: string[] = [];
    for (const range of ranges) {
      updated = `${updated.slice(0, range.start)}${range.insert}${updated.slice(range.end)}`;
      injected.push(...range.injected);
    }

    return { content: updated, injected };
  }

  private findClassRange(
    content: string,
    className: string
  ): { start: number; openBrace: number; closeBrace: number } | null {
    const classRegex = new RegExp(
      `\\b(?:abstract\\s+)?class\\s+${this.validator.escapeRegex(className)}\\b[^\\{]*\\{`,
      'g'
    );
    const match = classRegex.exec(content);
    if (!match || match.index === undefined) return null;
    const openBrace = content.indexOf('{', match.index);
    if (openBrace < 0) return null;
    const closeBrace = this.validator.findMatchingBrace(content, openBrace);
    if (closeBrace < 0) return null;
    return { start: match.index, openBrace, closeBrace };
  }

  private buildContractStubMethod(methodName: string): string {
    return `  dynamic ${methodName}([dynamic arg0, dynamic arg1, dynamic arg2, dynamic arg3]) {\n    return null;\n  }`;
  }

  private collectNonNullableFinalFields(classBody: string): Set<string> {
    const requiredFields = new Set<string>();
    const fieldRegex = /\b(?:late\s+)?final\s+([A-Za-z0-9_<>,\s?]+)\s+([A-Za-z_]\w*)\s*;/g;
    let match: RegExpExecArray | null;

    while ((match = fieldRegex.exec(classBody)) !== null) {
      const type = match[1].trim();
      const name = match[2];
      if (!type.includes('?')) requiredFields.add(name);
    }

    return requiredFields;
  }

  private fixDartConstructors(classBody: string, className: string, requiredFields: Set<string>): string {
    const constructorRegex = new RegExp(
      `\\b(?:const\\s+)?(?:factory\\s+)?${className}(?:\\s*\\.\\s*[A-Za-z_]\\w*)?\\s*\\(`,
      'g'
    );
    const matches: Array<{ startIndex: number; endIndex: number; content: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = constructorRegex.exec(classBody)) !== null) {
      const startIndex = match.index + match[0].length;
      const parsed = this.parseParenthesesBlock(classBody, startIndex - 1);
      if (!parsed) continue;
      matches.push({ startIndex, endIndex: parsed.endIndex, content: parsed.content });
    }

    let updatedBody = classBody;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const { startIndex, endIndex, content } = matches[i];
      const fixedParams = this.fixNamedParams(content, requiredFields);
      if (fixedParams === content) continue;
      updatedBody = updatedBody.slice(0, startIndex) + fixedParams + updatedBody.slice(endIndex);
    }

    return updatedBody;
  }

  private parseParenthesesBlock(
    source: string,
    openParenIndex: number
  ): { content: string; endIndex: number } | null {
    if (source[openParenIndex] !== '(') return null;
    let depth = 0;
    let i = openParenIndex;
    let inString: "'" | '"' | null = null;

    while (i < source.length) {
      const char = source[i];
      if (inString) {
        if (char === inString && source[i - 1] !== '\\') inString = null;
      } else if (char === '"' || char === "'") {
        inString = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) return { content: source.slice(openParenIndex + 1, i), endIndex: i };
      }
      i += 1;
    }

    return null;
  }

  private fixNamedParams(params: string, requiredFields: Set<string>): string {
    const namedBlock = this.extractNamedParamBlock(params);
    if (!namedBlock) return params;
    const { startIndex, endIndex, content } = namedBlock;
    const parts = this.splitTopLevelParams(content);
    const updatedParts = parts.map(part => this.ensureRequiredOnParam(part, requiredFields));
    return params.slice(0, startIndex) + updatedParts.join(', ') + params.slice(endIndex);
  }

  private extractNamedParamBlock(params: string): { startIndex: number; endIndex: number; content: string } | null {
    let depth = 0;
    let startIndex = -1;
    for (let i = 0; i < params.length; i += 1) {
      const char = params[i];
      if (char === '{') {
        if (depth === 0) startIndex = i + 1;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0 && startIndex !== -1) {
          return { startIndex, endIndex: i, content: params.slice(startIndex, i) };
        }
      }
    }
    return null;
  }

  private splitTopLevelParams(content: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depthParen = 0, depthAngle = 0, depthSquare = 0, depthBrace = 0;
    let inString: "'" | '"' | null = null;

    for (let i = 0; i < content.length; i += 1) {
      const char = content[i];
      if (inString) {
        current += char;
        if (char === inString && content[i - 1] !== '\\') inString = null;
        continue;
      }
      if (char === '"' || char === "'") { inString = char; current += char; continue; }

      if (char === '(') depthParen += 1;
      if (char === ')') depthParen -= 1;
      if (char === '<') depthAngle += 1;
      if (char === '>') depthAngle = Math.max(0, depthAngle - 1);
      if (char === '[') depthSquare += 1;
      if (char === ']') depthSquare -= 1;
      if (char === '{') depthBrace += 1;
      if (char === '}') depthBrace -= 1;

      if (char === ',' && depthParen === 0 && depthAngle === 0 && depthSquare === 0 && depthBrace === 0) {
        if (current.trim() !== '') parts.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }

    if (current.trim() !== '') parts.push(current.trim());
    return parts;
  }

  /**
   * Fix return/field types that are declared as `String` but actually hold an enum value.
   *
   * TypeScript string enums (`enum Foo { BAR = 'bar' }`) are ported to Dart enums,
   * but the LLM sometimes keeps the TypeScript-side type (`string` → `String`) instead
   * of using the Dart enum type.
   *
   * Patterns fixed:
   *   static String get FOO { return SomeEnum.member; }
   *   static String get FOO => SomeEnum.member;
   *   static String FOO = SomeEnum.member;
   *   static const String FOO = SomeEnum.member;
   *   static final String FOO = SomeEnum.member;
   *
   * In all cases, if the assigned/returned value is `EnumType.member`, replace `String`
   * with `EnumType`.
   */
  fixStringEnumTypes(content: string): string {
    let updated = content;

    // Pattern 1: getter with block body
    //   static String get NAME { return EnumType.member; }
    updated = updated.replace(
      /\bstatic\s+String\s+get\s+(\w+)\s*\{[^}]*\breturn\s+([A-Z][A-Za-z_]\w*)\.[a-zA-Z_]\w*\s*;[^}]*\}/g,
      (full, _getter, enumType) => full.replace(/\bString\b/, enumType),
    );

    // Pattern 2: getter with arrow body
    //   static String get NAME => EnumType.member;
    updated = updated.replace(
      /\bstatic\s+String\s+get\s+\w+\s*=>\s*([A-Z][A-Za-z_]\w*)\.[a-zA-Z_]\w*\s*;/g,
      (full, enumType) => full.replace(/\bString\b/, enumType),
    );

    // Pattern 3: field / const / final
    //   static String NAME = EnumType.member;
    //   static const String NAME = EnumType.member;
    //   static final String NAME = EnumType.member;
    updated = updated.replace(
      /\bstatic\s+(?:const\s+|final\s+)?String\s+(\w+)\s*=\s*([A-Z][A-Za-z_]\w*)\.[a-zA-Z_]\w*\s*;/g,
      (full, _field, enumType) => full.replace(/\bString\b/, enumType),
    );

    return updated;
  }

  /**
   * Remove empty stub classes/enums that the LLM fabricated to satisfy a missing import.
   *
   * When element.dart hasn't been ported yet, LLMs sometimes write:
   *   class Element {}
   * inside the current file instead of using an import. This method detects that:
   *
   * A declaration is removed when ALL of the following hold:
   *   (a) body is empty or near-empty (≤ 60 non-whitespace chars after stripping comments)
   *   (b) the name is NOT in sourceExportNames (i.e. not legitimately defined in this source file)
   *   (c) the name looks like it belongs elsewhere — either it matches an import-derived name,
   *       OR sourceExportNames is provided and the name simply doesn't appear in it
   *
   * @param sourceExportNames  Set of type names exported/defined by the source file.
   *                           When provided, any empty declaration NOT in this set is removed.
   *                           When omitted, falls back to import-line heuristics only.
   */
  removeImportedTypeStubs(content: string, sourceExportNames?: Set<string>): string {
    // Build the set of "foreign" names to remove
    // Strategy A: names derived from import lines (always collected)
    const importDerivedNames = new Set<string>();

    // 1. Explicit `show` names: import 'foo.dart' show Bar, Baz;
    const showRegex = /import\s+['"][^'"]+['"]\s+show\s+([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = showRegex.exec(content)) !== null) {
      for (const name of m[1].split(',')) {
        const trimmed = name.trim();
        if (/^[A-Za-z_]\w*$/.test(trimmed)) importDerivedNames.add(trimmed);
      }
    }

    // 2. Derive PascalCase name from filename: 'some_element.dart' → 'SomeElement'
    const fileImportRegex = /import\s+['"]([^'"]+\.dart)['"]/g;
    while ((m = fileImportRegex.exec(content)) !== null) {
      const filename = m[1].split('/').pop()!.replace(/\.dart$/, '');
      const pascal = filename
        .split(/[_\-]/)
        .map(part => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : ''))
        .join('');
      if (/^[A-Za-z_]\w*$/.test(pascal)) importDerivedNames.add(pascal);
    }

    // When sourceExportNames is provided: a name is "foreign" if it's not in the source exports.
    // When not provided: only names derived from import lines are considered foreign.
    const isForeignName = (name: string): boolean => {
      if (sourceExportNames) {
        // If sourceExportNames is known, trust it — anything not in the source is foreign
        return !sourceExportNames.has(name);
      }
      // Fallback: only remove if we can positively identify it as imported from another file
      return importDerivedNames.has(name);
    };

    if (!sourceExportNames && importDerivedNames.size === 0) return content;

    // Find and remove empty top-level declarations whose name is in importedNames
    const declRegex = /^\s*(?:(?:abstract|interface|sealed|base|final)\s+)*(class|enum|mixin|typedef)\s+([A-Za-z_]\w*)\b/gm;
    const removalRanges: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = declRegex.exec(content)) !== null) {
      const name = match[2];
      if (!isForeignName(name)) continue;

      const openBrace = content.indexOf('{', match.index + match[0].length - 1);
      if (openBrace < 0) continue;
      const closeBrace = this.validator.findMatchingBrace(content, openBrace);
      if (closeBrace < 0) continue;

      const kind = match[1]; // 'class' | 'enum' | 'mixin' | 'typedef'
      const body = content.slice(openBrace + 1, closeBrace).trim();
      // Only remove if body is empty or contains only comments / whitespace / very few tokens
      const nonWhitespaceTokens = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      // Enums with members (identifiers separated by commas) are never stubs.
      if (kind === 'enum' && /[A-Za-z_]\w*/.test(nonWhitespaceTokens)) continue;
      if (nonWhitespaceTokens.length > 60) continue; // has real content — keep it

      // Extend removal to include a trailing newline if present
      let end = closeBrace + 1;
      if (content[end] === '\n') end += 1;
      removalRanges.push({ start: match.index, end });
      declRegex.lastIndex = end;
    }

    if (removalRanges.length === 0) return content;

    // Remove ranges back-to-front
    removalRanges.sort((a, b) => b.start - a.start);
    let updated = content;
    for (const range of removalRanges) {
      updated = updated.slice(0, range.start) + updated.slice(range.end);
    }
    return updated.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Fix Map<String, int> declarations whose values are all enum member references.
   * TypeScript Record<string, number> with enum values should become Map<String, EnumType>
   * in Dart, not Map<String, int>.
   *
   * Pattern matched:
   *   Map<String, int> name = { 'key': SomeEnum.member, ... };
   * Becomes:
   *   Map<String, SomeEnum> name = { 'key': SomeEnum.member, ... };
   */
  fixEnumMapTypes(content: string): string {
    // Matches: (final/static/etc) Map<String, int> <name> = { ... };
    // We only replace if ALL non-empty values in the map literal are EnumName.member references.
    return content.replace(
      /((?:static\s+|final\s+)*)Map<String,\s*int>(\s+\w+\s*=\s*\{)([^}]*)\}/g,
      (full, modifiers, nameAndOpen, body) => {
        const entries = body.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        if (entries.length === 0) return full;

        // Each entry is 'key': EnumType.member — extract all referenced enum types
        const enumTypes = new Set<string>();
        for (const entry of entries) {
          // value part after the colon
          const colonIdx = entry.lastIndexOf(':');
          if (colonIdx === -1) return full;
          const value = entry.slice(colonIdx + 1).trim();
          const m = /^([A-Z][A-Za-z_]\w*)\.[a-zA-Z_]\w*$/.exec(value);
          if (!m) return full; // not an enum reference → leave unchanged
          enumTypes.add(m[1]);
        }

        if (enumTypes.size !== 1) return full; // mixed types → leave unchanged
        const [enumType] = enumTypes;
        return `${modifiers}Map<String, ${enumType}>${nameAndOpen}${body}}`;
      },
    );
  }

  /**
   * Detect invalid `const Foo = { ... }` object literal patterns in Dart output.
   *
   * TypeScript `export const Foo = { key: value }` should become a Dart class + const instance,
   * but LLMs sometimes copy the JS object literal syntax verbatim, which is invalid Dart.
   *
   * Returns a list of warning messages for each detected pattern.
   * The file should be flagged as requiring manual conversion.
   */
  detectInvalidConstObject(content: string): string[] {
    const warnings: string[] = [];

    // Pattern: `const Name = {` at top level (not inside a class or function)
    // This is invalid Dart — object literals cannot be used as const initializers
    const pattern = /\bconst\s+([A-Za-z_]\w*)\s*=\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      // Check that this is a top-level declaration (not inside a class body) by counting
      // open braces before this position — if depth is 0, it's top-level
      const before = content.slice(0, match.index);
      let depth = 0;
      let inString: '"' | "'" | null = null;
      let inLineComment = false;
      let inBlockComment = false;
      for (let i = 0; i < before.length; i++) {
        const ch = before[i];
        const next = before[i + 1];
        if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
        if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
        if (inString) { if (ch === '\\') { i++; continue; } if (ch === inString) inString = null; continue; }
        if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
        if (ch === '"' || ch === "'") { inString = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }

      if (depth === 0) {
        warnings.push(
          `Invalid Dart: top-level 'const ${name} = { ... }' object literal detected. ` +
          `Convert to a Dart class + const instance (see PromptBuilder rule #2).`
        );
      }
    }

    return warnings;
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
      if (bareMatch) fieldName = bareMatch[1];
    }

    if (!fieldName || !requiredFields.has(fieldName) || trimmed.includes('?')) return part;
    return `required ${trimmed}`;
  }
}
