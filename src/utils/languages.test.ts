import { describe, expect, it } from 'vitest';
import { detectLanguage, getFileExtensions, getTargetExtension } from './languages.js';

describe('languages utils', () => {
  it('detects the most common language by extension', () => {
    const result = detectLanguage({
      '.ts': 5,
      '.js': 2,
      '.py': 1,
    });

    expect(result).toBe('typescript');
  });

  it('returns known file extensions for a language', () => {
    expect(getFileExtensions('python')).toEqual(['.py']);
  });

  it('uses the target language primary extension', () => {
    const result = getTargetExtension('typescript', 'dart', '.ts');
    expect(result).toBe('.dart');
  });
});
