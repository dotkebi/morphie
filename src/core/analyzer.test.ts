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
