/**
 * File Porter Tool - Ports individual files with context awareness
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import { OllamaClient } from '../../llm/ollama.js';
import { PortingEngine } from '../../core/porting-engine.js';
import type { PortedFile } from '../../types/agent-types.js';

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
    private maxPromptTokens = 12000;

    constructor(llm: OllamaClient, options: FilePorterOptions = {}) {
        super();
        this.llm = llm;
        this.options = {
            verifyAfterPort: options.verifyAfterPort ?? true,
            maxRetries: options.maxRetries ?? 4,
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
            let attemptedChunking = false;

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

                    if (attempts === 2) {
                        engine.setPromptMode('reduced');
                    } else if (attempts >= 3) {
                        engine.setPromptMode('minimal');
                    }

                    const promptTokens = engine.estimatePromptTokens(file);
                    if (promptTokens > this.maxPromptTokens && !attemptedChunking) {
                        attemptedChunking = true;
                        const chunked = await this.portInChunks(
                            engine,
                            file,
                            sourceLanguage,
                            targetLanguage
                        );
                        return this.createSuccessResult({
                            success: true,
                            file: chunked,
                            chunked: true,
                        });
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
                    await this.sleep(this.getBackoffMs(attempts));
                }
            }

            if (!attemptedChunking && lastError?.includes('Empty response')) {
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
                engine.setPromptMode('minimal');
                try {
                    const chunked = await this.portInChunks(
                        engine,
                        file,
                        sourceLanguage,
                        targetLanguage
                    );
                    return this.createSuccessResult({
                        success: true,
                        file: chunked,
                        chunked: true,
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

    private getBackoffMs(attempt: number): number {
        if (attempt <= 1) return 0;
        if (attempt === 2) return 2000;
        if (attempt === 3) return 5000;
        return 10000;
    }

    private async sleep(ms: number): Promise<void> {
        if (ms <= 0) return;
        await new Promise(resolve => setTimeout(resolve, ms));
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

    private async portInChunks(
        engine: PortingEngine,
        file: any,
        sourceLanguage: string,
        targetLanguage: string
    ): Promise<PortedFile> {
        engine.setPromptMode('minimal');

        const estimatedTokens = engine.estimatePromptTokens(file);
        const chunkCount = Math.max(2, Math.ceil(estimatedTokens / this.maxPromptTokens));
        const chunks = this.splitContentIntoChunks(file.content, chunkCount);
        const outputs: string[] = [];

        for (let index = 0; index < chunks.length; index += 1) {
            const chunkContent = chunks[index];
            const ported = await engine.portFileWithOptions(file, {
                overrideContent: chunkContent,
                chunked: true,
                chunkIndex: index,
                totalChunks: chunks.length,
                suppressImports: index > 0,
            });
            let content = ported.content;
            if (index > 0) {
                content = this.stripImports(content);
            }
            outputs.push(content.trim());
        }

        let combined = outputs.join('\n\n').trim();
        if (targetLanguage === 'dart') {
            const targetPath = engine.getTargetPath(file.relativePath);
            combined = engine.finalizeImportsForTarget(combined, targetPath);
        }

        return {
            targetPath: engine.getTargetPath(file.relativePath),
            content: combined,
            originalPath: file.relativePath,
            sourceLanguage,
            targetLanguage,
        };
    }

    private stripImports(content: string): string {
        return content
            .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
            .replace(/^\s*library\s+[^;]+;\s*$/gm, '')
            .replace(/^\s*export\s+['"][^'"]+['"];?\s*$/gm, '')
            .trim();
    }

    private splitContentIntoChunks(content: string, chunkCount: number): string[] {
        const lines = content.split('\n');
        if (chunkCount <= 1 || lines.length <= 1) {
            return [content];
        }

        const targetLinesPerChunk = Math.ceil(lines.length / chunkCount);
        const boundaries = this.findChunkBoundaries(lines, targetLinesPerChunk);
        const chunks: string[] = [];

        let start = 0;
        for (const end of boundaries) {
            chunks.push(lines.slice(start, end).join('\n'));
            start = end;
        }
        if (start < lines.length) {
            chunks.push(lines.slice(start).join('\n'));
        }
        return chunks.filter(chunk => chunk.trim().length > 0);
    }

    private findChunkBoundaries(lines: string[], targetLinesPerChunk: number): number[] {
        const boundaries: number[] = [];
        const boundaryRegex = /^\s*(export\s+)?(class|interface|type|enum|function|const|let|var)\b/;
        let index = targetLinesPerChunk;
        while (index < lines.length) {
            let boundary = index;
            for (let i = index; i > Math.max(0, index - 50); i -= 1) {
                if (boundaryRegex.test(lines[i])) {
                    boundary = i;
                    break;
                }
            }
            boundaries.push(boundary);
            index = boundary + targetLinesPerChunk;
        }
        return boundaries;
    }
}
