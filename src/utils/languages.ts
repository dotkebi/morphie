export type FileType = 'source' | 'test' | 'config' | 'utility' | 'model' | 'service' | 'barrel';

const languageExtensions: Record<string, string[]> = {
  python: ['.py'],
  javascript: ['.js', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
  dart: ['.dart'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  kotlin: ['.kt', '.kts'],
  csharp: ['.cs'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
  c: ['.c', '.h'],
  ruby: ['.rb'],
  php: ['.php'],
  swift: ['.swift'],
};

const extensionToLanguage: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.dart': 'dart',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
};

export function detectLanguage(extensionCounts: Record<string, number>): string {
  let maxCount = 0;
  let detectedLanguage = 'unknown';

  for (const [ext, count] of Object.entries(extensionCounts)) {
    const language = extensionToLanguage[ext];
    if (language && count > maxCount) {
      maxCount = count;
      detectedLanguage = language;
    }
  }

  return detectedLanguage;
}

export function getFileExtensions(language: string): string[] {
  return languageExtensions[language] || [];
}

export function getTargetExtension(
  sourceLanguage: string,
  targetLanguage: string,
  sourceExt: string
): string {
  const targetExts = languageExtensions[targetLanguage];
  if (!targetExts || targetExts.length === 0) {
    return sourceExt;
  }

  // Return primary extension for target language
  return targetExts[0];
}

export function getLanguageFeatures(language: string): string {
  const features: Record<string, string> = {
    python: `- Dynamic typing with optional type hints
- Indentation-based scoping
- List comprehensions and generators
- Multiple inheritance
- Decorators for metaprogramming
- Context managers (with statement)`,

    javascript: `- Dynamic typing
- Prototype-based inheritance
- First-class functions and closures
- Async/await for asynchronous code
- Destructuring assignment
- Spread operator`,

    typescript: `- Static typing with type inference
- Interfaces and type aliases
- Generics
- Union and intersection types
- Decorators (experimental)
- ES6+ features`,

    go: `- Static typing with type inference
- Goroutines and channels for concurrency
- Interfaces (implicit implementation)
- Multiple return values
- Defer statement
- No exceptions (error values)`,

    rust: `- Static typing with ownership system
- Pattern matching
- Traits for polymorphism
- Result and Option types for error handling
- Lifetimes for memory safety
- Zero-cost abstractions`,

    java: `- Static typing
- Class-based OOP
- Interfaces and abstract classes
- Generics with type erasure
- Checked exceptions
- Annotations`,

    kotlin: `- Static typing with null safety
- Data classes
- Extension functions
- Coroutines for async
- Sealed classes
- Operator overloading`,

    csharp: `- Static typing with var inference
- Properties and events
- LINQ for querying
- Async/await
- Nullable reference types
- Extension methods`,

    cpp: `- Static typing
- Manual memory management
- Templates for generics
- Multiple inheritance
- Operator overloading
- RAII pattern`,

    ruby: `- Dynamic typing
- Everything is an object
- Blocks, procs, and lambdas
- Mixins via modules
- Open classes
- Metaprogramming`,

    swift: `- Static typing with inference
- Optionals for null safety
- Protocol-oriented programming
- Value types (structs)
- Extensions
- Pattern matching`,

    dart: `- Static typing with type inference
- Null safety (? for nullable, ! for non-null assertion)
- Classes with single inheritance, mixins for multiple
- async/await and Future/Stream for async
- Named and positional parameters
- Extension methods
- Factory constructors`,
  };

  return features[language] || '- Standard language features';
}

export function getSupportedLanguages(): string[] {
  return Object.keys(languageExtensions);
}
