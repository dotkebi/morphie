import path from 'path';
import type { SourceFile } from '../core/analyzer.js';
import { getLanguageFeatures } from '../utils/languages.js';
import type { ImportResolver } from './ImportResolver.js';

export interface PortingPromptOptions {
  overrideContent?: string;
  chunked?: boolean;
  chunkIndex?: number;
  totalChunks?: number;
  suppressImports?: boolean;
  passMode?: 'default' | 'skeleton' | 'body';
  skeletonHint?: string;
}

export class PromptBuilder {
  private sourceLanguage: string;
  private targetLanguage: string;
  private projectName: string;
  private promptMode: 'full' | 'reduced' | 'minimal';
  private apiSnapshot: string;
  private coreSymbolTable: Map<string, Set<string>>;
  private importResolver: ImportResolver;

  constructor(
    sourceLanguage: string,
    targetLanguage: string,
    projectName: string,
    importResolver: ImportResolver
  ) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.projectName = projectName;
    this.promptMode = 'full';
    this.apiSnapshot = '';
    this.coreSymbolTable = new Map();
    this.importResolver = importResolver;
  }

  setPromptMode(mode: 'full' | 'reduced' | 'minimal'): void {
    this.promptMode = mode;
  }

  setApiSnapshot(snapshot: string): void {
    this.apiSnapshot = snapshot.trim();
    this.rebuildCoreSymbolTable();
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  buildPortingPrompt(file: SourceFile, options: PortingPromptOptions = {}): string {
    if (this.promptMode === 'minimal') return this.buildMinimalPrompt(file, options);

    const sourceFeatures = getLanguageFeatures(this.sourceLanguage);
    const targetFeatures = getLanguageFeatures(this.targetLanguage);
    const importContext = options.suppressImports ? '' : this.buildImportContext(file);
    const apiSnapshot = this.buildApiSnapshotNotice();
    const sourceContent = options.overrideContent ?? file.content;

    const entryNotice = this.targetLanguage === 'dart' && this.isEntryFilePath(file.relativePath)
      ? `\n## Entry File Rules (CRITICAL)\n- This is an entry/bridge module. Keep only valid Dart directives at the top.\n- NEVER emit JavaScript module syntax (\`import ... from\`, \`export default\`, \`module.exports\`, \`require()\`).\n- If source uses default export/re-export, convert to explicit Dart top-level declarations.\n`
      : '';

    const chunkNotice = options.chunked
      ? `## Chunked Porting (CRITICAL)\nYou are porting chunk ${options.chunkIndex! + 1} of ${options.totalChunks!} from a larger file.\n- Output ONLY the code for this chunk, in correct order.\n- Do NOT add extra commentary.\n- ${options.suppressImports ? 'Do NOT include any import statements in this chunk.' : 'Include necessary import statements only if they belong at the top of the file.'}\n- If this chunk starts a top-level class/interface/enum block, keep wrapper start (\`class Foo {\`) intact.\n- ${(options.chunkIndex ?? 0) < ((options.totalChunks ?? 1) - 1) ? 'Do NOT close the final top-level type brace in this chunk unless it is structurally required inside a method.' : 'If this chunk is the last part of a split type, close the top-level type brace.'}\n`
      : '';

    const passNotice = options.passMode === 'skeleton'
      ? `## Pass Mode (CRITICAL)\nThis is SKELETON pass.\n- Preserve top-level structure, declarations, signatures, and class/member placement.\n- Keep method bodies minimal but syntactically valid.\n- Do NOT invent new APIs.\n`
      : options.passMode === 'body'
        ? `## Pass Mode (CRITICAL)\nThis is BODY fill pass.\n- Keep the same declarations/signatures as skeleton.\n- Fill real implementation bodies.\n- Do NOT duplicate top-level declarations.\n${options.skeletonHint ? `Reference skeleton:\n\`\`\`${this.targetLanguage}\n${options.skeletonHint}\n\`\`\`` : ''}\n`
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
13. **CRITICAL: TypeScript \`interface\` → Dart \`interface class\`** - TypeScript interfaces must be converted to \`interface class\` in Dart (requires Dart 3.0+), NOT \`abstract class\` and NOT plain \`class\`.
    - \`interface class\` enforces implementation contract: implementors must use \`implements\`, not \`extends\`.
    - Methods with no body in the TypeScript interface should have \`throw UnimplementedError();\` as body.
    - WRONG: \`abstract class GlyphProps { ... }\`
    - WRONG: \`class GlyphProps { ... }\`
    - RIGHT: \`interface class GlyphProps { ... }\`
14. **CRITICAL: \`late\` usage — only when initialization is deferred**
    - Use \`late\` ONLY when the field cannot be initialized in the constructor and will be assigned before first use.
    - Do NOT use \`late\` as a default for all non-nullable fields — this removes null safety guarantees and causes runtime errors if accessed before assignment.
    - Fields that are initialized in the constructor MUST be initialized there, not marked \`late\`.
    - WRONG: \`late String name;\` when name is always passed in the constructor
    - RIGHT: \`final String name;\` with \`this.name\` in constructor
    - Nullable optional fields → \`Type? name;\` (no \`late\`, no \`final\` unless immutable)
    - Immutable fields set once in constructor → \`final Type name;\`
    - Mutable fields set in constructor → \`Type name;\` (no modifier)
    - Truly deferred fields (set after construction, e.g. in \`init()\`) → \`late Type name;\`
15. **CRITICAL: \`Record<string, number>\` containing enum values → \`Map<String, EnumType>\`**
    - TypeScript \`Record<string, number>\` (or \`{ [key: string]: number }\`) whose values are enum members must become \`Map<String, EnumType>\`, NOT \`Map<String, int>\`.
    - Dart enum members are NOT integers — they are enum values. Using \`int\` as the value type is a type error.
    - WRONG: \`static final Map<String, int> justifyString = { 'left': MyEnum.left };\`
    - RIGHT: \`static final Map<String, MyEnum> justifyString = { 'left': MyEnum.left };\`
    - If the original code passes the map value to a function expecting \`int\`, use \`.index\` at the call site, not in the map declaration.
17. **CRITICAL: Never define stub/placeholder classes for imported types** - If a type is defined in another file, use an import statement — do NOT fabricate an empty class/enum in the current file.
    - WRONG: defining \`class Element {}\` inside modifier.dart because element.dart is not yet available
    - RIGHT: \`import 'element.dart';\` (or the correct relative path)
    - If the import path is unknown, write \`// TODO: import correct path for Element\` — never write a fake type definition.
16. **CRITICAL: TypeScript string enum → Dart enum (NOT String)**
    - TypeScript \`enum Category { GraceNoteGroup = 'gracenotegroup' }\` is a string enum. In Dart, port it as a plain \`enum Category { graceNoteGroup }\` (camelCase members).
    - Fields, getters, or return types that hold/return a string enum value must use the **enum type**, NOT \`String\`.
    - WRONG: \`static String get CATEGORY => Category.graceNoteGroup;\` (return type is String but value is an enum)
    - RIGHT: \`static Category get CATEGORY => Category.graceNoteGroup;\`
    - WRONG: \`static const String CATEGORY = Category.graceNoteGroup;\`
    - RIGHT: \`static const Category CATEGORY = Category.graceNoteGroup;\`
    - If you need the raw string value, call \`.name\` on the enum member: \`Category.graceNoteGroup.name\`

${importContext}
${apiSnapshot}
${entryNotice}

${chunkNotice}
${passNotice}

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
   - **CRITICAL: Nested objects must become nested const classes** — Do NOT flatten nested objects into \`Map<String, dynamic>\`. Each nested object literal must become its own \`const\`-constructible class.
   - Example with nested objects:
     \`\`\`typescript
     // TypeScript source
     export const CommonMetrics = {
       smufl: true,
       stave: { padding: 12, endPaddingMax: 10 },
     };
     \`\`\`
     \`\`\`dart
     // WRONG — invalid Dart (smufl is not a defined identifier; const map keys cannot be variables):
     const CommonMetrics = { smufl: true, stave: { 'padding': 12 } };
     // WRONG — loses type safety (nested object flattened into Map):
     const CommonMetrics = _CommonMetricsData(
       smufl: true,
       stave: {'padding': 12, 'endPaddingMax': 10},
     );
     // RIGHT:
     class _StaveMetrics {
       final int padding;
       final int endPaddingMax;
       const _StaveMetrics({required this.padding, required this.endPaddingMax});
     }
     class _CommonMetricsData {
       final bool smufl;
       final _StaveMetrics stave;
       const _CommonMetricsData({required this.smufl, required this.stave});
     }
     const CommonMetrics = _CommonMetricsData(
       smufl: true,
       stave: _StaveMetrics(padding: 12, endPaddingMax: 10),
     );
     \`\`\`

3. **Optional Parameters — named vs positional**:
   - TypeScript \`options?: Foo\` (object parameter) → Dart named parameter: \`{Foo? options}\`
   - TypeScript \`options = {}\` (with default empty object) → Dart named parameter with default: \`{Foo options = const Foo()}\` or keep nullable \`{Foo? options}\`
   - NEVER use positional optional syntax \`[Foo? options]\` for what was a named/object parameter in TypeScript.
   - WRONG: \`MyClass(String text, [Options? options])\`
   - RIGHT: \`MyClass(String text, {Options? options})\`

4. **Object spread / merge patterns**:
   - Dart has NO spread operator (\`...\`) for objects. NEVER emit \`{ ...obj, key: value }\` in Dart.
   - TypeScript \`this.opts = { default1: x, ...incoming }\` → Dart: assign each field explicitly:
     \`\`\`dart
     // WRONG (invalid Dart):
     options = { ignoreTicks: false, line: 2, ...options };
     // RIGHT:
     this.ignoreTicks = options?.ignoreTicks ?? false;
     this.line = options?.line ?? 2;
     \`\`\`
   - TypeScript \`this.renderOptions = { ...this.renderOptions, fill_style: '#000' }\` →
     Dart: update only the changed field on the existing object, or use \`copyWith\` if available:
     \`\`\`dart
     // WRONG:
     renderOptions = { ...renderOptions, 'fill_style': '#000000' };
     // RIGHT (if RenderOptions has copyWith):
     renderOptions = renderOptions.copyWith(fillStyle: '#000000');
     // RIGHT (if plain assignment):
     renderOptions.fillStyle = '#000000';
     \`\`\`

5. **Options object parameter — keep as typed object, not individual fields**:
   - If TypeScript receives \`options: { fill_style?: string }\`, do NOT flatten it into \`{String? fillStyle}\` as a separate parameter.
   - Keep it as a typed options class parameter: \`{OptionsType? options}\` and reference \`options?.fillStyle\` in the body.
   - WRONG: \`Annotation(StaveNote note, int position, String text, {String? fillStyle})\`
   - RIGHT: \`Annotation(StaveNote note, int position, String text, {AnnotationOptions? options})\`

## Source Code (${file.relativePath})
\`\`\`${this.sourceLanguage}
${sourceContent}
\`\`\`

## Ported Code
Provide ONLY the ported code in ${this.targetLanguage}, wrapped in a code block.

**CRITICAL REQUIREMENTS - YOU MUST INCLUDE ALL DEFINITIONS**:
1. Include ALL exports from the source file (enums, interfaces, types, classes, functions)
2. Include ALL methods in classes, including private methods
3. Do NOT add organizational comments or section dividers
4. Maintain exact structure from source`;

    if (this.promptMode === 'reduced') {
      return this.buildReducedPrompt(file, importContext, sourceFeatures, targetFeatures, options);
    }

    return fullPrompt;
  }

  buildDeclarationPrompt(
    file: SourceFile,
    declarationSource: string,
    options: {
      passMode?: 'default' | 'skeleton' | 'body';
      skeletonHint?: string;
      classNameHint?: string;
    } = {}
  ): string {
    const passMode = options.passMode ?? 'default';
    return `You are converting one TOP-LEVEL declaration from ${this.sourceLanguage} to ${this.targetLanguage}.

Return ONLY JSON object:
{"code":"<ported declaration code>"}

Rules:
- Convert ONLY this declaration.
- Do NOT include imports/exports/comments outside the declaration.
- Keep declaration structure valid in target language.
- Do NOT wrap with markdown.
${options.classNameHint ? `- This declaration belongs to class ${options.classNameHint}.` : ''}
${passMode === 'skeleton' ? '- Skeleton pass: keep signatures/shape, minimal valid bodies.' : ''}
${passMode === 'body' ? '- Body pass: fill implementation, keep declaration/signatures stable.' : ''}
${options.skeletonHint ? `Skeleton reference:\n${options.skeletonHint}\n` : ''}

Source declaration:
\`\`\`${this.sourceLanguage}
${declarationSource}
\`\`\`
`;
  }

  buildClassMemberPrompt(memberSource: string, className: string, skeletonHint?: string): string {
    return `Convert one ${this.sourceLanguage} class member to ${this.targetLanguage}.

Return ONLY JSON:
{"member":"<ported class member code>"}

Rules:
- Output only a class member (field/constructor/method/getter/setter), not a full class.
- Do NOT include imports.
- Keep behavior and signature.
- Class name: ${className}
${skeletonHint ? `Class skeleton reference:\n${skeletonHint}\n` : ''}

Source member:
\`\`\`${this.sourceLanguage}
${memberSource}
\`\`\`
`;
  }

  buildImportContext(file: SourceFile): string {
    if (this.targetLanguage !== 'dart') return '';

    const importRegex = /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    const imports: Array<{ path: string; symbols: string[] }> = [];
    let match;

    while ((match = importRegex.exec(file.content)) !== null) {
      const importPath = match[1];
      const symbolMatch = match[0].match(/import\s+\{([^}]+)\}/);
      const symbols = symbolMatch
        ? symbolMatch[1].split(',').map(s => s.trim().split(' as ')[0].trim())
        : [];
      imports.push({ path: importPath, symbols });
    }

    if (imports.length === 0 && this.importResolver.mapping.symbolToFile.size === 0) return '';

    const currentTargetPath = this.convertFilePath(file.relativePath);
    const currentFileSymbols = file.exports.map(s => s.name);

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
      `**MANDATORY CHECKLIST - Your output MUST include ALL of these**:
      ${symbolsByType.enum.length > 0 ? `- Enums: ${symbolsByType.enum.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.interface.length > 0 ? `- Interfaces (convert to class): ${symbolsByType.interface.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.type.length > 0 ? `- Types (convert to typedef or class): ${symbolsByType.type.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.class.length > 0 ? `- Classes: ${symbolsByType.class.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.function.length > 0 ? `- Functions: ${symbolsByType.function.map(s => s.name).join(', ')}` : ''}
      ${symbolsByType.const.length > 0 ? `- Constants: ${symbolsByType.const.map(s => s.name).join(', ')}` : ''}`,
      '',
      '### Import Rules:',
      `1. Use package imports for files in different directories: \`import 'package:${this.projectName}/path/to/file.dart';\``,
      `2. Use relative imports ONLY for files in the same directory: \`import 'file.dart';\``,
      '3. File paths must use snake_case',
      '4. NEVER invent package names or file names - only use paths that exist in the import mapping below',
      '',
    ];

    if (imports.length > 0) {
      lines.push('### Required imports for this file:');
      for (const imp of imports) {
        const targetPath = this.importResolver.resolveImportPath(imp.path, file.relativePath);
        if (targetPath && targetPath === currentTargetPath) continue;
        if (targetPath) {
          lines.push(`- \`${imp.path}\` → \`${this.importResolver.buildDartImportStatement(targetPath, currentTargetPath)}\``);
        } else {
          const resolvedSourcePath = path.normalize(
            path.join(path.dirname(file.relativePath), imp.path).replace(/\.(ts|js|tsx|jsx)$/, '')
          ).replace(/\\/g, '/');
          const dartPath = this.transformPath(this.importResolver.toSnakeCase(resolvedSourcePath) + '.dart');
          lines.push(`- \`${imp.path}\` → \`${this.importResolver.buildDartImportStatement(dartPath, currentTargetPath)}\``);
        }
      }
      lines.push('');
    }

    const nestedTypes = this.importResolver.findNestedTypesInFile(file, currentTargetPath);
    if (nestedTypes.length > 0) {
      lines.push('### Nested Types (IMPORTANT - EXTRACT to top-level):');
      for (const nested of nestedTypes) {
        lines.push(`- \`${nested.qualifiedName}\` → extract as \`${nested.parentClass}${nested.name}\` (Top-level)`);
      }
      lines.push('');
    }

    const ambiguousSymbols = this.importResolver.findAmbiguousSymbols(file);
    if (ambiguousSymbols.length > 0) {
      lines.push('### Ambiguous Symbols (Multiple definitions exist):');
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

    if (this.importResolver.mapping.qualifiedNameToLocation.size > 0) {
      const symbolToImport = new Map<string, string>();
      for (const [qualifiedName, location] of this.importResolver.mapping.qualifiedNameToLocation) {
        const { filePath, symbol } = location;
        if (filePath === currentTargetPath) continue;
        const isUsed =
          file.content.includes(symbol.name) ||
          file.content.includes(qualifiedName) ||
          (symbol.parentClass && file.content.includes(`${symbol.parentClass}.${symbol.name}`));

        if (isUsed) {
          const importStatement = this.importResolver.buildDartImportStatement(filePath, currentTargetPath);
          if (symbol.parentClass) {
            const key = qualifiedName;
            if (!symbolToImport.has(key)) {
              symbolToImport.set(key, `- \`${qualifiedName}\` → ${importStatement} then use \`${symbol.parentClass}${symbol.name}\` (Top-level)`);
            }
          } else {
            const key = symbol.name;
            if (!symbolToImport.has(key)) {
              symbolToImport.set(key, `- \`${symbol.name}\` → ${importStatement}`);
            }
          }
        }
      }

      if (symbolToImport.size > 0) {
        lines.push('### Symbol locations (use these exact imports):');
        lines.push(...Array.from(symbolToImport.values()).slice(0, 40));
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  buildApiSnapshotNotice(): string {
    if (!this.apiSnapshot) return '';
    return `\n## Core API Contract (CRITICAL)\nUse these method/type contracts exactly when referenced:\n${this.apiSnapshot}\n`;
  }

  convertFilePath(sourcePath: string, sourceLanguage?: string, targetLanguage?: string): string {
    const src = sourceLanguage ?? this.sourceLanguage;
    const tgt = targetLanguage ?? this.targetLanguage;

    // Simple extension mapping placeholder — full logic is in PortingEngine
    // This is used only internally for import context building
    const extMap: Record<string, string> = {
      '.ts': tgt === 'dart' ? '.dart' : '.ts',
      '.js': tgt === 'dart' ? '.dart' : '.js',
      '.tsx': tgt === 'dart' ? '.dart' : '.tsx',
    };
    const ext = path.extname(sourcePath);
    const targetExt = extMap[ext] ?? ext;
    const basePath = sourcePath.slice(0, -ext.length);
    return this.transformPath(basePath + targetExt);
  }

  isEntryFilePath(sourceRelativePath: string, targetPath?: string): boolean {
    const source = sourceRelativePath.replace(/\\/g, '/');
    const target = (targetPath ?? '').replace(/\\/g, '/');
    return (
      source.startsWith('entry/') ||
      source.includes('/entry/') ||
      target.startsWith('entry/') ||
      target.includes('/entry/')
    );
  }

  private buildReducedPrompt(
    file: SourceFile,
    importContext: string,
    sourceFeatures: string,
    targetFeatures: string,
    options: PortingPromptOptions = {}
  ): string {
    const apiSnapshot = this.buildApiSnapshotNotice();
    const sourceContent = options.overrideContent ?? file.content;
    const passNotice = options.passMode === 'skeleton'
      ? '\nPass mode: skeleton only. Keep signatures/structure, minimal valid bodies.\n'
      : options.passMode === 'body'
        ? `\nPass mode: body fill. Keep declarations/signatures from skeleton. ${options.skeletonHint ? `Skeleton:\n\`\`\`${this.targetLanguage}\n${options.skeletonHint}\n\`\`\`` : ''}\n`
        : '';
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
1-12. (same as full prompt)

${importContext}
${apiSnapshot}
${passNotice}

## Source Code
\`\`\`${this.sourceLanguage}
${sourceContent}
\`\`\`

## Output
Provide ONLY the ported code in ${this.targetLanguage}, wrapped in a code block.`;
  }

  private buildMinimalPrompt(file: SourceFile, options: PortingPromptOptions = {}): string {
    const importContext = options.suppressImports ? '' : this.buildImportContext(file);
    const sourceContent = options.overrideContent ?? file.content;
    const apiSnapshot = this.buildApiSnapshotNotice();
    const entryNotice = this.targetLanguage === 'dart' && this.isEntryFilePath(file.relativePath)
      ? '\nEntry module: no JS module syntax, no `export default`, only valid Dart directives.\n'
      : '';
    const chunkNotice = options.chunked
      ? `\nChunk ${options.chunkIndex! + 1} of ${options.totalChunks!}. ${options.suppressImports ? 'Do NOT include imports.' : 'Include imports only if appropriate at top of file.'} Keep top-level type wrapper boundaries. ${(options.chunkIndex ?? 0) < ((options.totalChunks ?? 1) - 1) ? 'Do not close final top-level type brace in this chunk.' : 'Close top-level type brace if this is the final split chunk.'}\n`
      : '';
    const passNotice = options.passMode === 'skeleton'
      ? '\nPass mode: skeleton. Keep declarations/signatures and minimal valid bodies.\n'
      : options.passMode === 'body'
        ? `\nPass mode: body fill. Keep declarations/signatures; fill implementation. ${options.skeletonHint ? `\nSkeleton reference:\n\`\`\`${this.targetLanguage}\n${options.skeletonHint}\n\`\`\`\n` : ''}`
        : '';

    return `Port this ${this.sourceLanguage} code to ${this.targetLanguage}.
Preserve behavior, structure, signatures, and comments.
Include all definitions and methods (including private).
Do not add extra commentary. Output only code in a code block.

${importContext}
${apiSnapshot}
${entryNotice}

${chunkNotice}
${passNotice}

Source:
\`\`\`${this.sourceLanguage}
${sourceContent}
\`\`\``;
  }

  private rebuildCoreSymbolTable(): void {
    this.coreSymbolTable.clear();
    if (!this.apiSnapshot) return;

    const lines = this.apiSnapshot.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const methodsMatch = line.match(/methods:\s*(.+)$/);
      if (!methodsMatch) continue;
      const methods = methodsMatch[1].split(',').map(item => item.trim()).filter(Boolean);
      const exportsMatch = line.match(/exports:\s*([^|]+)/);
      if (!exportsMatch) continue;
      const exported = exportsMatch[1].split(',').map(item => item.trim());
      for (const entry of exported) {
        const classMatch = entry.match(/\bclass\s+([A-Za-z_]\w*)/);
        if (!classMatch) continue;
        const className = classMatch[1];
        if (!this.coreSymbolTable.has(className)) this.coreSymbolTable.set(className, new Set());
        const bucket = this.coreSymbolTable.get(className)!;
        for (const method of methods) bucket.add(method);
      }
    }
  }

  private transformPath(filePath: string): string {
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
}
