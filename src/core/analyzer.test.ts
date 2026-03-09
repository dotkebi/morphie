import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ProjectAnalyzer } from './analyzer.js';

describe('ProjectAnalyzer', () => {
  it('detects the dominant project language from files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morphie-analyzer-'));
    try {
      await fs.writeFile(path.join(tempDir, 'a.ts'), 'export const a = 1;');
      await fs.writeFile(path.join(tempDir, 'b.ts'), 'export const b = 2;');
      await fs.writeFile(path.join(tempDir, 'c.js'), 'module.exports = {};');

      const analyzer = new ProjectAnalyzer(tempDir);
      const analysis = await analyzer.analyze();

      expect(analysis.language).toBe('typescript');
      expect(analysis.files.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts dependencies from package.json for TypeScript projects', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morphie-analyzer-'));
    try {
      await fs.writeFile(path.join(tempDir, 'index.ts'), 'export const value = 1;');
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          {
            dependencies: {
              chalk: '^5.0.0',
            },
            devDependencies: {
              vitest: '^1.0.0',
            },
          },
          null,
          2
        )
      );

      const analyzer = new ProjectAnalyzer(tempDir);
      const analysis = await analyzer.analyze();

      expect(analysis.dependencies).toEqual(
        expect.arrayContaining(['chalk', 'vitest'])
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts exports accurately via AST', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morphie-analyzer-'));
    try {
      await fs.writeFile(
        path.join(tempDir, 'shapes.ts'),
        `
export class Circle {}
export abstract class Shape {}
export interface Drawable { draw(): void; }
export type Color = 'red' | 'blue';
export enum Direction { Up, Down }
export function helper() {}
export const MAX = 100;
export const factory = () => {};

export class Stave {
  static Position = { ABOVE: 0, BELOW: 1 };
}

export { Circle as default };
        `.trim()
      );

      const analyzer = new ProjectAnalyzer(tempDir, 'typescript');
      const analysis = await analyzer.analyze();
      const file = analysis.files.find(f => f.relativePath === 'shapes.ts');
      const names = file!.exports.map(e => e.name);

      expect(names).toContain('Circle');
      expect(names).toContain('Shape');
      expect(names).toContain('Drawable');
      expect(names).toContain('Color');
      expect(names).toContain('Direction');
      expect(names).toContain('helper');
      expect(names).toContain('MAX');
      expect(names).toContain('factory');

      // Static nested enum-like member
      const position = file!.exports.find(e => e.name === 'Position');
      expect(position).toBeDefined();
      expect(position!.parentClass).toBe('Stave');
      expect(position!.qualifiedName).toBe('Stave.Position');

      // Type classification
      expect(file!.exports.find(e => e.name === 'helper')!.type).toBe('function');
      expect(file!.exports.find(e => e.name === 'factory')!.type).toBe('function');
      expect(file!.exports.find(e => e.name === 'MAX')!.type).toBe('const');
      expect(file!.exports.find(e => e.name === 'Drawable')!.type).toBe('interface');
      expect(file!.exports.find(e => e.name === 'Color')!.type).toBe('type');
      expect(file!.exports.find(e => e.name === 'Direction')!.type).toBe('enum');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('builds dependency graph via AST import analysis', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morphie-analyzer-'));
    try {
      await fs.writeFile(path.join(tempDir, 'a.ts'), `import { b } from './b';`);
      await fs.writeFile(path.join(tempDir, 'b.ts'), `export const b = 1;`);
      await fs.writeFile(path.join(tempDir, 'c.ts'), `export * from './b';`);

      const analyzer = new ProjectAnalyzer(tempDir, 'typescript');
      const analysis = await analyzer.analyze();

      expect(analysis.dependencyGraph.edges['a.ts']).toContain('b.ts');
      expect(analysis.dependencyGraph.edges['c.ts']).toContain('b.ts');
      expect(analysis.dependencyGraph.edges['b.ts']).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects entry points for TypeScript projects', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morphie-analyzer-'));
    try {
      await fs.writeFile(path.join(tempDir, 'main.ts'), 'console.log("main");');
      await fs.writeFile(path.join(tempDir, 'cli.ts'), 'console.log("cli");');

      const analyzer = new ProjectAnalyzer(tempDir);
      const analysis = await analyzer.analyze();

      expect(analysis.entryPoints).toEqual(
        expect.arrayContaining(['main.ts', 'cli.ts'])
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
