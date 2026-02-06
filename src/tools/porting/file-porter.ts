/**
 * File Porter Tool - Ports individual files with context awareness
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import { OllamaClient } from '../../llm/ollama.js';
import { PortingEngine } from '../../core/porting-engine.js';
import type { SourceFile, PortedFile } from '../../types/agent-types.js';

export interface FilePorterOptions {
    verifyAfterPort?: boolean;
    maxRetries?: number;
    includeComments?: boolean;
}

export class FilePorter extends BaseTool {
    readonly name = 'file-porter';
    readonly description = 'Ports individual files with full context awareness and self-verification';
    readonly category = 'porting' as const;

    private llm: OllamaClient;
    private options: Required<FilePorterOptions>;

    constructor(llm: OllamaClient, options: FilePorterOptions = {}) {
        super();
        this.llm = llm;
        this.options = {
            verifyAfterPort: options.verifyAfterPort ?? true,
            maxRetries: options.maxRetries ?? 2,
            includeComments: options.includeComments ?? true,
        };
    }

    async execute(context: ToolContext): Promise<ToolResult> {
        try {
            this.validateContext(context, ['file', 'sourceLanguage', 'targetLanguage']);

            const file = context.file as any; // Use any to avoid type conflicts
            const sourceLanguage = context.sourceLanguage as string;
            const targetLanguage = context.targetLanguage as string;
            const projectName = (context.projectName as string) || 'ported_project';
            const verbose = (context.verbose as boolean) || false;
            const allFiles = context.allFiles as any[] | undefined;

            let attempts = 0;
            let lastError: string | undefined;

            while (attempts < this.options.maxRetries) {
                attempts++;

                try {
                    // Create a minimal porting engine for this file
                    // PortingEngine(llm, sourceLanguage, targetLanguage, verbose, projectName)
                    const engine = new PortingEngine(
                        this.llm,
                        sourceLanguage,
                        targetLanguage,
                        verbose,
                        projectName
                    );

                    if (allFiles) {
                        engine.buildImportMapping(allFiles);
                    }

                    // Port the file
                    const ported = await engine.portFile(file);

                    if (ported.skipped) {
                        return this.createSuccessResult({
                            skipped: true,
                            reason: 'File skipped by porting engine',
                            file: ported,
                        });
                    }

                    // Verify if enabled
                    if (this.options.verifyAfterPort) {
                        const verification = this.quickVerify(ported.content, targetLanguage);
                        if (!verification.valid) {
                            lastError = verification.issues.join(', ');
                            continue; // Retry
                        }
                    }

                    return this.createSuccessResult({
                        success: true,
                        file: ported,
                    });

                } catch (error) {
                    lastError = error instanceof Error ? error.message : String(error);
                }
            }

            return this.createFailureResult(
                `Failed to port file after ${attempts} attempts: ${lastError}`
            );

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.createFailureResult(`File porter error: ${message}`);
        }
    }

    /**
     * Quick syntax verification for ported code
     */
    private quickVerify(
        code: string,
        language: string
    ): { valid: boolean; issues: string[] } {
        const issues: string[] = [];

        if (!code || code.trim().length === 0) {
            issues.push('Empty code generated');
            return { valid: false, issues };
        }

        // Language-specific basic checks
        switch (language) {
            case 'dart':
                if (!code.includes(';') && code.length > 50) {
                    // Dart code should have semicolons
                    issues.push('Missing semicolons (possible syntax issue)');
                }
                break;

            case 'python':
                // Python should have proper indentation
                if (code.includes('\t') && code.includes('    ')) {
                    issues.push('Mixed tabs and spaces');
                }
                break;

            case 'go':
                // Go should have package declaration
                if (!code.includes('package ')) {
                    issues.push('Missing package declaration');
                }
                break;
        }

        return {
            valid: issues.length === 0,
            issues,
        };
    }
}
