# Agent Documentation for Morphie

This document provides comprehensive guidance for AI agents working on the Morphie codebase. Morphie is a CLI tool that ports open source projects from one programming language to another using local LLM (Ollama).

## Project Overview

**Morphie** uses local LLM to perform 1:1 code translation between programming languages while preserving:
- Exact functionality and behavior
- Code structure and organization
- Function/method signatures (adapted to target language conventions)
- Comments and documentation

### Key Capabilities

- **Multi-language support**: TypeScript, JavaScript, Python, Go, Dart, Rust, Java, Kotlin, etc.
- **Intelligent import mapping**: Resolves cross-file dependencies and generates correct import statements
- **Naming convention conversion**: Automatically converts file names (e.g., camelCase → snake_case)
- **Structure preservation**: Maintains original folder/class structure
- **Progress tracking**: Real-time progress with ETA estimates

## Quick Start Commands

### Build, Test, and Development
- `npm install` - Install dependencies
- `npm run build` - Compile TypeScript to `dist/`
- `npm run dev -- <command>` - Run CLI directly from `src/` via `tsx` (no build)
- `npm start -- <command>` - Run compiled CLI from `dist/`
- `npm run lint` - Check code style with ESLint
- `npm run lint:fix` - Auto-fix linting issues
- `npm test` - Run all tests with Vitest
- `npm run test:watch` - Run tests in watch mode

### Running Single Tests
- `npx vitest run src/core/analyzer.test.ts` - Run specific test file
- `npx vitest run --reporter=verbose src/utils/languages.test.ts` - Run with verbose output
- `npx vitest run -t "detects the most common language"` - Run tests matching pattern

## Architecture Overview

### Project Structure

```
src/
├── cli.ts                    # CLI entry point (Commander.js setup)
├── index.ts                  # Library exports
├── commands/                 # CLI command handlers
│   ├── port.ts              # Main porting workflow
│   ├── analyze.ts           # Project analysis only
│   └── models.ts            # List available Ollama models
├── core/                     # Core porting logic
│   ├── analyzer.ts          # ProjectAnalyzer: scans source, detects language, extracts exports
│   └── porting-engine.ts    # PortingEngine: builds prompts, calls LLM, extracts code
├── llm/                      # LLM integration
│   └── ollama.ts            # OllamaClient: HTTP client for Ollama API
└── utils/                    # Utility modules
    ├── filesystem.ts        # File I/O operations
    ├── languages.ts         # Language detection, extensions, features
    ├── import-mapper.ts     # Import path resolution (if exists)
    └── project-config.ts    # Generates project config files (pubspec.yaml, Cargo.toml, etc.)
```

### Component Responsibilities

#### 1. CLI Layer (`src/cli.ts`, `src/commands/`)

- **`cli.ts`**: Sets up Commander.js CLI with three commands:
  - `port`: Main porting command
  - `analyze`: Analyze project without porting
  - `models`: List available Ollama models

- **`commands/port.ts`**: Orchestrates the porting workflow:
  1. Validates source directory
  2. Connects to Ollama
  3. Analyzes source project
  4. Creates target directory
  5. Builds import mapping
  6. Ports each file sequentially
  7. Generates project config files
  8. Displays progress and results

#### 2. Core Logic (`src/core/`)

- **`analyzer.ts` - ProjectAnalyzer**:
  - Detects project language (or uses specified language)
  - Collects all source files matching language extensions
  - Extracts exported symbols (classes, functions, interfaces, enums, etc.)
  - Identifies nested types (e.g., `Stave.Position`)
  - Finds entry points and dependencies
  - Classifies files (source, test, config, barrel, etc.)

- **`porting-engine.ts` - PortingEngine**:
  - Builds comprehensive import mapping across all files
  - Generates LLM prompts with:
    - Source and target language features
    - Import path mappings
    - Nested type information
    - Ambiguous symbol disambiguation
    - Language-specific conversion rules
  - Calls LLM via `OllamaClient`
  - Extracts ported code from LLM response
  - Handles special cases (barrel files, naming conventions)

#### 3. LLM Integration (`src/llm/ollama.ts`)

- **OllamaClient**: HTTP client for Ollama REST API
  - `healthCheck()`: Verifies Ollama is running
  - `listModels()`: Fetches available models
  - `generate()`: Non-streaming code generation
  - `generateStream()`: Streaming generation (for future use)
  - Default settings: `temperature: 0.1`, `topP: 0.9`, `maxTokens: 4096`

#### 4. Utilities (`src/utils/`)

- **`filesystem.ts`**: File I/O abstraction (read, write, directory operations)
- **`languages.ts`**: Language support definitions:
  - File extensions per language
  - Language detection logic
  - Language feature descriptions (used in prompts)
  - Target extension mapping
- **`project-config.ts`**: Generates project configuration files:
  - `pubspec.yaml` for Dart
  - `pyproject.toml` for Python
  - `go.mod` for Go
  - `Cargo.toml` for Rust
  - `.gitignore` and `README.md` for all

## Data Flow

### Porting Workflow

```
1. User runs: morphie port ./src ./output -f typescript -t dart

2. CLI (port.ts):
   ├─> Validates source directory
   ├─> Creates OllamaClient
   ├─> Health check Ollama
   └─> Creates ProjectAnalyzer

3. ProjectAnalyzer.analyze():
   ├─> Detects/uses language
   ├─> Collects files (glob patterns)
   ├─> For each file:
   │   ├─> Reads content
   │   ├─> Classifies file type
   │   └─> Extracts exports (regex-based)
   └─> Returns ProjectAnalysis

4. PortingEngine:
   ├─> buildImportMapping(files):
   │   ├─> Maps symbols to file paths
   │   ├─> Maps qualified names (e.g., "Stave.Position")
   │   ├─> Tracks ambiguous symbols
   │   └─> Builds file-to-symbols mapping
   │
   └─> For each file:
       ├─> portFile(file):
       │   ├─> buildPortingPrompt(file):
       │   │   ├─> Gets language features
       │   │   ├─> buildImportContext(file):
       │   │   │   ├─> Resolves import paths
       │   │   │   ├─> Finds nested types
       │   │   │   └─> Identifies ambiguous symbols
       │   │   └─> Combines into full prompt
       │   │
       │   ├─> llm.generate(prompt)
       │   ├─> extractCode(response)
       │   └─> Returns PortedFile
       │
       └─> Write to target directory

5. Generate project files:
   └─> generateProjectFiles() → Write config, .gitignore, README
```

### Import Mapping System

The import mapping system is critical for generating correct import statements in the target language:

1. **Symbol Extraction**: `ProjectAnalyzer.extractExports()` uses regex to find:
   - Top-level exports: `export class Foo`, `export function bar`
   - Nested types: `static Position = { ... }` inside classes
   - Qualified names: `Stave.Position` for nested enums

2. **Mapping Building**: `PortingEngine.buildImportMapping()` creates:
   - `symbolToFile`: Simple name → file path
   - `qualifiedNameToLocation`: Full qualified name → location
   - `fileToSymbols`: File → exported symbols
   - `simpleNameToLocations`: Simple name → all locations (for disambiguation)

3. **Import Context**: `buildImportContext()` generates context for each file:
   - Package name (snake_case project name)
   - Current file path
   - Required imports with correct Dart package paths
   - Nested type information
   - Ambiguous symbol warnings

## LLM Prompt Engineering

### Prompt Structure

The prompt built by `PortingEngine.buildPortingPrompt()` includes:

1. **Task Description**: Clear instruction for 1:1 code port
2. **Source Language Features**: Key characteristics from `languages.ts`
3. **Target Language Features**: Key characteristics from `languages.ts`
4. **Guidelines**: General porting rules
5. **Import Context**: Language-specific import mapping (Dart package imports, etc.)
6. **Special Cases**: 
   - TypeScript → Dart enum conversion
   - Nested enums/types handling
   - Reserved keyword renaming
7. **Source Code**: The actual file content to port
8. **Output Format**: Instruction to return only code in code block

### Language-Specific Rules

The prompt includes language-specific conversion rules:

- **TypeScript → Dart**: Enhanced enums, package imports, nested type handling
- **Reserved Keywords**: Comprehensive list of Dart reserved keywords with renaming suggestions
- **Naming Conventions**: File path conversion (camelCase → snake_case for Dart)

## How to Extend the System

### Adding a New Language

1. **Update `src/utils/languages.ts`**:
   ```typescript
   // Add to languageExtensions
   languageExtensions['newlang'] = ['.nl'];
   
   // Add to extensionToLanguage
   extensionToLanguage['.nl'] = 'newlang';
   
   // Add language features
   features['newlang'] = `- Feature 1
   - Feature 2
   ...`;
   ```

2. **Update `src/utils/project-config.ts`**:
   - Add config generator function (e.g., `generateNewLangConfig()`)
   - Add to `generators` object in `generateProjectConfig()`
   - Add `.gitignore` patterns if needed

3. **Update `src/core/analyzer.ts`**:
   - Add export extraction regex patterns in `extractExports()` if needed
   - Add entry point patterns in `findEntryPoints()`
   - Add dependency file parsing in `parseDependencies()`

4. **Update `src/core/porting-engine.ts`**:
   - Add path transformation logic in `transformPath()` if needed
   - Add special case handling in `portFile()` if needed
   - Update prompt generation in `buildPortingPrompt()` for language-specific rules

### Adding New Export Types

To extract additional export types (e.g., constants, namespaces):

1. **Update `ExportedSymbol` type** in `analyzer.ts`:
   ```typescript
   type: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'variable' | 'namespace'
   ```

2. **Add extraction regex** in `ProjectAnalyzer.extractExports()`:
   ```typescript
   const namespaceRegex = /export\s+namespace\s+(\w+)/g;
   // ... add to symbols array
   ```

3. **Update import mapping** if namespace affects import resolution

### Improving Import Resolution

The import mapping system can be enhanced:

1. **Better Path Resolution**: Currently uses simple path joining. Could add:
   - Package.json path mapping
   - TypeScript path aliases support
   - Relative path normalization

2. **Symbol Usage Analysis**: Currently only checks if symbol name appears in file. Could:
   - Parse actual imports to find used symbols
   - Use AST parsing instead of regex
   - Track symbol references across files

3. **Circular Dependency Detection**: Add detection and handling for circular imports

### Adding AST Parsing

Currently uses regex for export extraction. Could improve with AST:

1. **Install parser**: `@typescript-eslint/parser` for TS/JS, `tree-sitter` for multi-language
2. **Replace regex in `extractExports()`**: Use AST traversal
3. **Benefits**: More accurate, handles edge cases, better nested type detection

## Common Tasks

### Debugging Porting Issues

1. **Enable verbose mode**: `-v` flag shows detailed information
2. **Check LLM response**: Add logging in `OllamaClient.generate()`
3. **Inspect prompts**: Log prompt in `PortingEngine.buildPortingPrompt()`
4. **Verify import mapping**: Log `importMapping` after `buildImportMapping()`

### Testing New Language Support

1. **Create test project**: Small project with various constructs
2. **Run analyze**: `morphie analyze ./test-project -f newlang -v`
3. **Dry run**: `morphie port ./test-project ./output -f newlang -t dart --dry-run`
4. **Full port**: `morphie port ./test-project ./output -f newlang -t dart -v`
5. **Verify output**: Check generated code quality and imports

### Optimizing Performance

Current bottlenecks:
- Sequential file porting (could parallelize)
- LLM API calls (no caching)
- File I/O (could batch writes)

Potential improvements:
- Parallel porting with worker threads
- Cache LLM responses for identical files
- Batch file operations

## Build, Test, and Development Commands

- `npm install` - Install dependencies
- `npm run dev -- <command>` - Run CLI directly from `src/` via `tsx` (no build)
- `npm run build` - Compile TypeScript to `dist/`
- `npm start -- <command>` - Run compiled CLI from `dist/`
- `npm run lint` - Check code style with ESLint
- `npm run lint:fix` - Auto-fix linting issues
- `npm test` - Run Vitest test suite
- `npm run test:watch` - Watch mode for tests

Example: `npm run dev -- port ./input ./output -f typescript -t dart`

## Code Style Guidelines

### Language & Environment
- **Language**: TypeScript only (ES2022 target, NodeNext modules)
- **File Structure**: All source code in `src/` directory
- **Imports**: Use ES modules with `.js` extensions in import statements
- **Strict Mode**: TypeScript strict mode enabled

### Formatting & Style
- **Indentation**: 2 spaces (no tabs)
- **Line Length**: No hard limit, but keep lines readable
- **Semicolons**: Required
- **Quotes**: Single quotes for strings, double quotes for JSON-like strings
- **Trailing Commas**: Use in multiline objects/arrays

### Naming Conventions
- **Variables/Functions**: `camelCase` (e.g., `analyzeProject`, `sourcePath`)
- **Classes/Interfaces/Types**: `PascalCase` (e.g., `ProjectAnalyzer`, `SourceFile`)
- **Constants**: `UPPER_SNAKE_CASE` (rare, but when used)
- **File Names**: `kebab-case` for CLI commands, `camelCase` for utilities (e.g., `porting-engine.ts`, `project-config.ts`)
- **CLI Flags**: `kebab-case` (e.g., `--dry-run`, `--ollama-url`)
- **Private Members**: Prefix with `_` (e.g., `_sourcePath`)

### TypeScript Specific
- **Type Annotations**: Always provide explicit types for function parameters and return values
- **Interfaces vs Types**: Use interfaces for object shapes, types for unions/aliases
- **Optional Properties**: Use `?:` for optional properties
- **Generic Constraints**: Use `extends` for generic constraints
- **Enum Values**: `PascalCase` for enum names, `camelCase` for values
- **Union Types**: Use `|` for unions, avoid `any` except in rare cases

### Import/Export Patterns
```typescript
// Named imports (preferred)
import { glob } from 'glob';
import { FileSystem } from '../utils/filesystem.js';

// Default imports
import path from 'path';

// Export patterns
export interface SourceFile { /* ... */ }
export class ProjectAnalyzer { /* ... */ }
export { analyzeProject } from './commands/analyze.js';
```

### Error Handling
- Use `try/catch` for async operations
- Provide user-friendly error messages
- Exit with appropriate codes (1 for errors)
- Throw custom Error subclasses with descriptive messages
- Use optional chaining (`?.`) and nullish coalescing (`??`)

### Code Organization
- **File Structure**: Group related functionality in directories (`core/`, `utils/`, `commands/`)
- **Class Organization**: Public methods first, then private methods
- **Function Length**: Keep functions focused and under 50 lines when possible
- **Comments**: JSDoc for public APIs, inline comments for complex logic only

### Testing
- **Framework**: Vitest with `describe`/`it`/`expect` syntax
- **File Naming**: `*.test.ts` alongside implementation files
- **Test Structure**: Arrange-Act-Assert pattern
- **Mocking**: Use Vitest's mocking capabilities for external dependencies

### Linting & Quality
- **ESLint**: `eslint:recommended` + `@typescript-eslint/recommended`
- **Auto-fix**: Run `npm run lint:fix` before committing
- **Type Checking**: Run `npm run build` to ensure no TypeScript errors

## Testing Guidelines

- Tests run with Vitest via `npm test` or `npm run test:watch`
- Test files use `*.test.ts` naming convention
- Keep tests focused on:
  - CLI behavior
  - Porting logic
  - Language detection
  - Import mapping
  - Edge cases

## Commit & Pull Request Guidelines

- **Commit messages**: Short, imperative, optional emoji prefixes (e.g., `:tada: begin project`)
- **Commits**: Clear, single-purpose commits explaining change intent
- **Pull requests**: Include:
  - Brief summary
  - Relevant CLI examples
  - Mention Ollama/model used for validation
  - Test results if applicable

## Configuration & Runtime Notes

- **Requirements**: Node.js 18+ and local Ollama instance
- **Model selection**: Configurable via `--model` or `--ollama-url` CLI flags
- **Default model**: `codellama:7b`
- **Default Ollama URL**: `http://localhost:11434`
- **Recommended models**: Code-focused models like `codellama`, `qwen2.5-coder`, `deepseek-coder`

## Key Patterns

### Error Handling

- Use try-catch in async operations
- Provide user-friendly error messages
- Exit with appropriate codes (1 for errors)

### Progress Display

- Use `ora` spinner for progress
- Show file-by-file progress
- Calculate and display ETA every N files

### File Path Handling

- Always use `path.join()` for cross-platform compatibility
- Normalize paths with `path.normalize()`
- Convert separators for target language conventions

### LLM Integration

- Always check health before use
- Handle empty responses gracefully
- Extract code from markdown code blocks
- Provide fallback if extraction fails

## Troubleshooting

### Common Issues

1. **Ollama connection failed**: Check if Ollama is running (`ollama serve`)
2. **Empty LLM response**: Check model availability, try different model
3. **Import errors in output**: Verify import mapping, check package name
4. **Nested types not handled**: Check `extractExports()` regex patterns
5. **File naming wrong**: Check `transformPath()` logic for target language

### Debugging Tips

- Use `--verbose` flag for detailed output
- Check generated prompts in `buildPortingPrompt()`
- Verify import mapping after `buildImportMapping()`
- Test with small projects first
- Compare source and target file structures
