/**
 * Syntax Checker Tool - Validates syntax of ported code
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import type { SyntaxError } from '../../types/agent-types.js';

export interface SyntaxCheckResult {
    valid: boolean;
    errors: SyntaxError[];
    warnings: string[];
}

export class SyntaxChecker extends BaseTool {
    readonly name = 'syntax-checker';
    readonly description = 'Validates syntax of ported code using language-specific rules';
    readonly category = 'verification' as const;

    async execute(context: ToolContext): Promise<ToolResult> {
        try {
            this.validateContext(context, ['code', 'language']);

            const code = context.code as string;
            const language = context.language as string;

            const result = this.checkSyntax(code, language);

            return this.createSuccessResult(result);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.createFailureResult(`Syntax check failed: ${message}`);
        }
    }

    /**
     * Check syntax for the given language
     */
    private checkSyntax(code: string, language: string): SyntaxCheckResult {
        const errors: SyntaxError[] = [];
        const warnings: string[] = [];
        const lines = code.split('\n');

        switch (language) {
            case 'dart':
                this.checkDartSyntax(lines, errors, warnings);
                break;
            case 'python':
                this.checkPythonSyntax(lines, errors, warnings);
                break;
            case 'go':
                this.checkGoSyntax(lines, errors, warnings);
                break;
            case 'java':
                this.checkJavaSyntax(lines, errors, warnings);
                break;
            case 'kotlin':
                this.checkKotlinSyntax(lines, errors, warnings);
                break;
            case 'rust':
                this.checkRustSyntax(lines, errors, warnings);
                break;
            default:
                this.checkGenericSyntax(lines, errors, warnings);
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings,
        };
    }

    private checkDartSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        let braceCount = 0;
        let parenCount = 0;
        let bracketCount = 0;

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            const lineNum = index + 1;

            // Skip comments
            if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
                return;
            }

            // Count brackets
            for (const char of line) {
                switch (char) {
                    case '{': braceCount++; break;
                    case '}': braceCount--; break;
                    case '(': parenCount++; break;
                    case ')': parenCount--; break;
                    case '[': bracketCount++; break;
                    case ']': bracketCount--; break;
                }
            }

            // Check for unbalanced brackets
            if (braceCount < 0) {
                errors.push({
                    file: 'current',
                    line: lineNum,
                    message: 'Unexpected closing brace',
                });
                braceCount = 0;
            }
            if (parenCount < 0) {
                errors.push({
                    file: 'current',
                    line: lineNum,
                    message: 'Unexpected closing parenthesis',
                });
                parenCount = 0;
            }

            // Check for missing semicolons
            if (
                trimmed.length > 0 &&
                !trimmed.endsWith(';') &&
                !trimmed.endsWith('{') &&
                !trimmed.endsWith('}') &&
                !trimmed.endsWith(',') &&
                !trimmed.endsWith('(') &&
                !trimmed.startsWith('@') &&
                !trimmed.startsWith('import ') &&
                !trimmed.startsWith('export ') &&
                !trimmed.startsWith('//') &&
                !trimmed.includes('=>') &&
                trimmed.includes(' ')
            ) {
                // Heuristic: might be missing semicolon
                // This is a simplified check
            }
        });

        // Final bracket balance check
        if (braceCount !== 0) {
            errors.push({
                file: 'current',
                message: `Unbalanced braces: ${braceCount > 0 ? 'missing closing' : 'extra closing'} brace`,
            });
        }
        if (parenCount !== 0) {
            errors.push({
                file: 'current',
                message: `Unbalanced parentheses: ${parenCount > 0 ? 'missing closing' : 'extra closing'}`,
            });
        }
        if (bracketCount !== 0) {
            errors.push({
                file: 'current',
                message: `Unbalanced brackets: ${bracketCount > 0 ? 'missing closing' : 'extra closing'}`,
            });
        }
    }

    private checkPythonSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        let inMultilineString = false;

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            const lineNum = index + 1;

            // Check multiline strings
            const tripleQuotes = (line.match(/"""/g) || []).length;
            if (tripleQuotes % 2 === 1) {
                inMultilineString = !inMultilineString;
            }

            if (inMultilineString) return;

            // Check for common issues
            if (trimmed.startsWith('def ') && !trimmed.endsWith(':')) {
                if (!trimmed.includes('->')) {
                    warnings.push(`Line ${lineNum}: Function definition might be missing colon`);
                }
            }

            if (trimmed.startsWith('class ') && !trimmed.endsWith(':')) {
                errors.push({
                    file: 'current',
                    line: lineNum,
                    message: 'Class definition missing colon',
                });
            }

            // Check indentation consistency
            if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
                // Top-level statement
            } else if (line.includes('\t') && line.includes('    ')) {
                errors.push({
                    file: 'current',
                    line: lineNum,
                    message: 'Mixed tabs and spaces in indentation',
                });
            }
        });
    }

    private checkGoSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        let hasPackage = false;
        let braceCount = 0;

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            const lineNum = index + 1;

            if (trimmed.startsWith('package ')) {
                hasPackage = true;
            }

            // Count braces
            for (const char of line) {
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
            }

            if (braceCount < 0) {
                errors.push({
                    file: 'current',
                    line: lineNum,
                    message: 'Unexpected closing brace',
                });
                braceCount = 0;
            }
        });

        if (!hasPackage) {
            errors.push({
                file: 'current',
                line: 1,
                message: 'Missing package declaration',
            });
        }

        if (braceCount !== 0) {
            errors.push({
                file: 'current',
                message: 'Unbalanced braces',
            });
        }
    }

    private checkJavaSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        // Similar to Dart checks
        let braceCount = 0;

        lines.forEach((line, index) => {
            for (const char of line) {
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
            }
        });

        if (braceCount !== 0) {
            errors.push({
                file: 'current',
                message: 'Unbalanced braces',
            });
        }
    }

    private checkKotlinSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        // Similar to Java/Dart checks
        this.checkJavaSyntax(lines, errors, warnings);
    }

    private checkRustSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        let braceCount = 0;

        lines.forEach((line, index) => {
            const trimmed = line.trim();

            for (const char of line) {
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
            }

            // Check for missing semicolons in statements
            if (
                trimmed.startsWith('let ') &&
                !trimmed.endsWith(';') &&
                !trimmed.endsWith('{')
            ) {
                warnings.push(`Line ${index + 1}: Let statement might be missing semicolon`);
            }
        });

        if (braceCount !== 0) {
            errors.push({
                file: 'current',
                message: 'Unbalanced braces',
            });
        }
    }

    private checkGenericSyntax(
        lines: string[],
        errors: SyntaxError[],
        warnings: string[]
    ): void {
        // Basic bracket matching for any language
        let braceCount = 0;
        let parenCount = 0;

        lines.forEach((line) => {
            for (const char of line) {
                switch (char) {
                    case '{': braceCount++; break;
                    case '}': braceCount--; break;
                    case '(': parenCount++; break;
                    case ')': parenCount--; break;
                }
            }
        });

        if (braceCount !== 0) {
            errors.push({ file: 'current', message: 'Unbalanced braces' });
        }
        if (parenCount !== 0) {
            errors.push({ file: 'current', message: 'Unbalanced parentheses' });
        }
    }
}
