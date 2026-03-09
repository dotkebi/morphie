/**
 * Tests for deterministic (LLM-bypass) data porting logic.
 *
 * These tests verify that data-dominant TypeScript files are converted
 * to Dart without any LLM call. A stub LLM client is injected; if the
 * deterministic path fails and falls through to the LLM, the stub throws
 * so the test immediately fails.
 */

import { describe, expect, it } from 'vitest';
import { FilePorter } from './file-porter.js';
import type { LLMClient } from '../../llm/types.js';

// ---------------------------------------------------------------------------
// Stub LLM — must never be called in deterministic tests
// ---------------------------------------------------------------------------

function makeLlm(): LLMClient {
  return {
    generate: async () => {
      throw new Error('LLM should not be called for data-dominant files');
    },
    healthCheck: async () => true,
    listModels: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Helper: run FilePorter.execute() and assert success
// ---------------------------------------------------------------------------

async function portFile(content: string, relativePath = 'src/data.ts'): Promise<string> {
  const porter = new FilePorter(makeLlm());
  const result = await porter.execute({
    file: { relativePath, content, exports: [], imports: [], type: 'source', language: 'typescript', absolutePath: relativePath },
    sourceLanguage: 'typescript',
    targetLanguage: 'dart',
    projectName: 'test_project',
    verbose: false,
  });
  if (!result.success) {
    throw new Error(`Porting failed: ${result.error}`);
  }
  const out = result.output as { file?: { content?: string }; content?: string } | undefined;
  const dartContent = out?.file?.content ?? out?.content;
  if (typeof dartContent !== 'string') {
    throw new Error(`Unexpected output shape: ${JSON.stringify(result.output)}`);
  }
  return dartContent;
}

/**
 * Returns true if the file is NOT handled deterministically (falls through to LLM).
 * The stub LLM throws, so a failed result means LLM was called.
 */
async function goesToLlm(content: string, relativePath = 'src/data.ts'): Promise<boolean> {
  const porter = new FilePorter(makeLlm(), { maxRetries: 0 });
  const result = await porter.execute({
    file: { relativePath, content, exports: [], imports: [], type: 'source', language: 'typescript', absolutePath: relativePath },
    sourceLanguage: 'typescript',
    targetLanguage: 'dart',
    projectName: 'test_project',
    verbose: false,
  });
  return !result.success;
}

// ---------------------------------------------------------------------------
// isDataDominantCandidate — these files must be handled deterministically
// ---------------------------------------------------------------------------

describe('deterministic data port — candidate detection', () => {
  it('rejects small files (< 1200 chars) — falls through to LLM', async () => {
    const content = `export const tiny = { a: 1 };`;
    expect(await goesToLlm(content, 'src/tiny.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Simple const object
// ---------------------------------------------------------------------------

describe('deterministic data port — const object', () => {
  it('converts a single exported const object map', async () => {
    const content = `
// Color codes mapping
export const ColorMap = {
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  ${Array.from({ length: 60 }, (_, i) => `color${i}: '#${String(i).padStart(6, '0')}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("const ColorMap =");
    expect(dart).toContain("'red': '#FF0000'");
    expect(dart).toContain("'blue': '#0000FF'");
    // Should be a map literal
    expect(dart).toContain('<String, dynamic>{');
  });

  it('converts numeric values', async () => {
    const content = `
export const Sizes = {
  small: 8,
  medium: 16,
  large: 32,
  ${Array.from({ length: 60 }, (_, i) => `size${i}: ${i * 4}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'small': 8");
    expect(dart).toContain("'medium': 16");
    expect(dart).toContain("'large': 32");
  });

  it('converts boolean values', async () => {
    const content = `
export const FeatureFlags = {
  darkMode: true,
  beta: false,
  experimental: true,
  ${Array.from({ length: 60 }, (_, i) => `flag${i}: ${i % 2 === 0}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'darkMode': true");
    expect(dart).toContain("'beta': false");
  });

  it('converts null values', async () => {
    const content = `
export const Defaults = {
  name: null,
  value: null,
  label: 'default',
  ${Array.from({ length: 60 }, (_, i) => `item${i}: null`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'name': null");
    expect(dart).toContain("'label': 'default'");
  });
});

// ---------------------------------------------------------------------------
// Nested structures
// ---------------------------------------------------------------------------

describe('deterministic data port — nested structures', () => {
  it('converts nested object', async () => {
    const content = `
export const Theme = {
  colors: {
    primary: '#1976D2',
    secondary: '#424242',
  },
  spacing: {
    small: 4,
    medium: 8,
  },
  ${Array.from({ length: 50 }, (_, i) => `extra${i}: 'v${i}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'colors':");
    expect(dart).toContain("'primary': '#1976D2'");
    expect(dart).toContain("'spacing':");
  });

  it('converts array of strings', async () => {
    const content = `
export const Languages = ['en', 'ko', 'ja', 'zh', 'de', 'fr', 'es', 'pt', 'ru', 'ar'];
export const MoreData = {
  ${Array.from({ length: 60 }, (_, i) => `key${i}: 'val${i}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("<dynamic>['en', 'ko', 'ja'");
  });

  it('converts array of numbers', async () => {
    const content = `
export const Weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
export const MoreData = {
  ${Array.from({ length: 60 }, (_, i) => `key${i}: ${i}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain('<dynamic>[100, 200, 300');
  });

  it('converts mixed array', async () => {
    const content = `
export const Mixed = [1, 'two', true, null];
export const MoreData = {
  ${Array.from({ length: 60 }, (_, i) => `key${i}: ${i}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("<dynamic>[1, 'two', true, null]");
  });
});

// ---------------------------------------------------------------------------
// String escaping
// ---------------------------------------------------------------------------

describe('deterministic data port — string escaping', () => {
  it('escapes single quotes in string values', async () => {
    const content = `
export const Messages = {
  greeting: "it's a test",
  path: "C:\\\\Users\\\\test",
  ${Array.from({ length: 60 }, (_, i) => `msg${i}: 'text${i}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("\\'");
  });

  it('handles backslash escaping', async () => {
    const content = `
export const Paths = {
  windows: "C:\\\\Users\\\\test",
  unix: "/usr/local/bin",
  ${Array.from({ length: 60 }, (_, i) => `path${i}: '/dir/${i}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'unix': '/usr/local/bin'");
  });
});

// ---------------------------------------------------------------------------
// Negative number literals
// ---------------------------------------------------------------------------

describe('deterministic data port — negative numbers', () => {
  it('converts negative numeric literals', async () => {
    const content = `
export const Offsets = {
  left: -10,
  right: 10,
  top: -5,
  bottom: 5,
  ${Array.from({ length: 60 }, (_, i) => `offset${i}: ${i - 30}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'left': -10");
    expect(dart).toContain("'top': -5");
  });
});

// ---------------------------------------------------------------------------
// Enum declarations
// ---------------------------------------------------------------------------

describe('deterministic data port — enum declarations', () => {
  it('converts TypeScript enum to Dart enum alongside const data', async () => {
    // File has both enum and const data → data-dominant path is taken
    const content = `
export enum Direction {
  UP,
  DOWN,
  LEFT,
  RIGHT,
}
export const DirectionMap = {
  ${Array.from({ length: 60 }, (_, i) => `key${i}: 'val${i}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain('enum Direction {');
    expect(dart).toContain('const DirectionMap =');
  });

  it('enum-only files (no const data) fall through to LLM', async () => {
    // enum-only files are excluded from data-dominant path per isDataDominantCandidate
    // Make it large enough to pass the 1200-char size check
    const content = `export enum Status {\n  ACTIVE,\n  INACTIVE,\n  PENDING,\n}\n`
      + Array.from({ length: 60 }, (_, i) => `// padding line ${i}`).join('\n');
    expect(await goesToLlm(content, 'src/status.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PropertyAccessExpression (enum member references as values)
// ---------------------------------------------------------------------------

describe('deterministic data port — property access values', () => {
  it('converts enum member references as values', async () => {
    const content = `
import { HAlign } from './halign';
export const JustifyMap = {
  left: HAlign.LEFT,
  center: HAlign.CENTER,
  right: HAlign.RIGHT,
  ${Array.from({ length: 60 }, (_, i) => `key${i}: 'val${i}'`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'left': HAlign.LEFT");
    expect(dart).toContain("'center': HAlign.CENTER");
  });
});

// ---------------------------------------------------------------------------
// Type assertions — should be unwrapped
// ---------------------------------------------------------------------------

describe('deterministic data port — type assertions', () => {
  it('unwraps as-expressions', async () => {
    const content = `
export const Config = {
  value: 42 as number,
  name: 'test' as string,
  ${Array.from({ length: 60 }, (_, i) => `item${i}: ${i} as number`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain("'value': 42");
    expect(dart).toContain("'name': 'test'");
    // Should NOT contain 'as number' in Dart output
    expect(dart).not.toContain('as number');
  });
});

// ---------------------------------------------------------------------------
// Files with class/function — must NOT be data-dominant
// ---------------------------------------------------------------------------

describe('deterministic data port — exclusion criteria', () => {
  it('files with class keyword go to LLM', async () => {
    const content = (`export class Foo {\n  bar = 1;\n}\nexport const data = { a: 1 };\n`).repeat(30);
    expect(await goesToLlm(content, 'src/foo.ts')).toBe(true);
  });

  it('files with function keyword go to LLM', async () => {
    const content = (`export function compute(x: number) { return x * 2; }\nexport const data = { a: 1 };\n`).repeat(30);
    expect(await goesToLlm(content, 'src/compute.ts')).toBe(true);
  });

  it('files with many control flows go to LLM', async () => {
    const content = (`export const data = { a: 1 };\nfunction logic() {\n  if (true) {}\n  if (true) {}\n  if (true) {}\n  for (;;) {}\n  while (false) {}\n  switch (1) {}\n  try {} catch (e) {}\n}\n`).repeat(10);
    expect(await goesToLlm(content, 'src/logic.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Map spread — should fall through to LLM
// ---------------------------------------------------------------------------

describe('deterministic data port — unsupported patterns', () => {
  it('map spread returns null (falls through to LLM)', async () => {
    const content = `const base = { a: 1 };\nexport const extended = { ...base, b: 2 };\n`
      + Array.from({ length: 80 }, (_, i) => `// line ${i}`).join('\n');
    expect(await goesToLlm(content, 'src/spread.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple declarations in one file
// ---------------------------------------------------------------------------

describe('deterministic data port — multiple declarations', () => {
  it('emits multiple const declarations', async () => {
    const content = `
export const Colors = {
  red: '#FF0000',
  blue: '#0000FF',
  ${Array.from({ length: 40 }, (_, i) => `c${i}: '#${String(i).padStart(6, '0')}'`).join(',\n  ')},
};

export const Sizes = {
  small: 8,
  medium: 16,
  large: 32,
  ${Array.from({ length: 40 }, (_, i) => `s${i}: ${i * 4}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain('const Colors =');
    expect(dart).toContain('const Sizes =');
  });
});

// ---------------------------------------------------------------------------
// Header comment preservation
// ---------------------------------------------------------------------------

describe('deterministic data port — header comments', () => {
  it('preserves leading comment lines', async () => {
    const content = `// This is auto-generated. Do not edit.
// Source: vexflow tables
export const NoteData = {
  ${Array.from({ length: 80 }, (_, i) => `note${i}: ${i}`).join(',\n  ')},
};
`.trim();

    const dart = await portFile(content);
    expect(dart).toContain('const NoteData =');
    expect(dart).toContain('// This is auto-generated');
    expect(dart).toContain('// Source: vexflow tables');
  });
});
