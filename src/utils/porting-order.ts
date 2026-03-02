import path from 'path';

export interface FileForOrdering {
  relativePath: string;
  content: string;
}

function isScriptLanguage(language: string): boolean {
  const lang = language.toLowerCase();
  return lang === 'typescript' || lang === 'javascript';
}

function extensionCandidates(base: string): string[] {
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.jsx'),
  ];
}

function extractLocalImports(content: string): string[] {
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
      const importPath = match[1];
      if (importPath.startsWith('.')) {
        imports.add(importPath);
      }
    }
  }

  return Array.from(imports);
}

function resolveLocalImport(importPath: string, fromFile: string, fileSet: Set<string>): string | null {
  const fromDir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const base = path.posix.normalize(path.posix.join(fromDir, importPath)).replace(/\\/g, '/');
  for (const candidate of extensionCandidates(base)) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getCorePriority(relativePath: string, targetLanguage: string): number {
  if (targetLanguage !== 'dart') {
    return 100;
  }
  const priorities = new Map<string, number>([
    ['src/element.ts', 0],
    ['src/tickable.ts', 1],
    ['src/fraction.ts', 2],
    ['src/tables.ts', 3],
    ['src/typeguard.ts', 4],
    ['src/util.ts', 5],
    ['src/boundingbox.ts', 6],
    ['src/rendercontext.ts', 7],
    ['src/stave.ts', 8],
  ]);
  return priorities.get(relativePath) ?? 100;
}

function sortByPriority(paths: string[], targetLanguage: string): string[] {
  return [...paths].sort((a, b) => {
    const pa = getCorePriority(a, targetLanguage);
    const pb = getCorePriority(b, targetLanguage);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

export function orderFilesForPorting<T extends FileForOrdering>(
  files: T[],
  sourceLanguage: string,
  targetLanguage: string
): T[] {
  if (files.length <= 1) {
    return files;
  }

  const base = sortByPriority(files.map(file => file.relativePath), targetLanguage);
  const pathToFile = new Map(files.map(file => [file.relativePath.replace(/\\/g, '/'), file] as const));

  if (!isScriptLanguage(sourceLanguage)) {
    return base.map(relativePath => pathToFile.get(relativePath)!).filter(Boolean);
  }

  const fileSet = new Set(pathToFile.keys());
  const depsByFile = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const filePath of fileSet) {
    depsByFile.set(filePath, new Set());
    reverse.set(filePath, new Set());
    indegree.set(filePath, 0);
  }

  for (const file of files) {
    const filePath = file.relativePath.replace(/\\/g, '/');
    const locals = extractLocalImports(file.content);
    for (const localImport of locals) {
      const dep = resolveLocalImport(localImport, filePath, fileSet);
      if (!dep || dep === filePath) continue;
      depsByFile.get(filePath)!.add(dep);
    }
  }

  for (const [filePath, deps] of depsByFile) {
    for (const dep of deps) {
      reverse.get(dep)!.add(filePath);
      indegree.set(filePath, (indegree.get(filePath) ?? 0) + 1);
    }
  }

  const ready = sortByPriority(
    Array.from(indegree.entries()).filter(([, deg]) => deg === 0).map(([p]) => p),
    targetLanguage
  );
  const orderedPaths: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    orderedPaths.push(current);
    const dependents = reverse.get(current);
    if (!dependents) continue;
    for (const dependent of dependents) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
      }
    }
    ready.sort((a, b) => {
      const pa = getCorePriority(a, targetLanguage);
      const pb = getCorePriority(b, targetLanguage);
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
  }

  if (orderedPaths.length < files.length) {
    const remaining = sortByPriority(
      Array.from(fileSet).filter(filePath => !orderedPaths.includes(filePath)),
      targetLanguage
    );
    orderedPaths.push(...remaining);
  }

  return orderedPaths.map(relativePath => pathToFile.get(relativePath)!).filter(Boolean);
}
