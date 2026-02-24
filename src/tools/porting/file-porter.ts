/**
 * File Porter Tool - Ports individual files with context awareness
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import type { LLMClient } from '../../llm/types.js';
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

    private llm: LLMClient;
    private options: Required<FilePorterOptions>;
    private maxPromptTokens = 2200;
    private reducedPromptTokens = 1400;
    private minimalPromptTokens = 1800;

    constructor(llm: LLMClient, options: FilePorterOptions = {}) {
        super();
        this.llm = llm;
        this.options = {
            verifyAfterPort: options.verifyAfterPort ?? true,
            maxRetries: options.maxRetries ?? 6,
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

                    if (attempts >= 3) {
                        engine.setPromptMode('minimal');
                    } else if (attempts === 2) {
                        engine.setPromptMode('reduced');
                    } else if (promptTokens > this.minimalPromptTokens) {
                        engine.setPromptMode('minimal');
                    } else if (promptTokens > this.reducedPromptTokens) {
                        engine.setPromptMode('reduced');
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
        const initialChunks = await this.splitContentIntoChunks(
            file.content,
            chunkCount,
            sourceLanguage,
            file.relativePath
        );
        const chunks = this.enforceChunkTokenLimit(engine, file, initialChunks);
        const outputs: string[] = [];

        for (let index = 0; index < chunks.length; index += 1) {
            const chunkContent = chunks[index];
            const suppressImports = targetLanguage === 'dart' ? true : index > 0;
            const ported = await engine.portFileWithOptions(file, {
                overrideContent: chunkContent,
                chunked: true,
                chunkIndex: index,
                totalChunks: chunks.length,
                suppressImports,
            });
            let content = ported.content;
            if (targetLanguage === 'dart' || index > 0) {
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

    private async splitContentIntoChunks(
        content: string,
        chunkCount: number,
        sourceLanguage: string,
        filePath: string
    ): Promise<string[]> {
        if (this.canUseTypeScriptAst(sourceLanguage, filePath)) {
            try {
                const chunks = await this.splitWithTypeScriptAst(content, chunkCount, filePath);
                if (chunks.length > 1) {
                    return chunks;
                }
            } catch {
                // Fallback to line-based chunking when AST parsing fails
            }
        }

        return this.splitByLineBoundaries(content, chunkCount);
    }

    private splitByLineBoundaries(content: string, chunkCount: number): string[] {
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

    private canUseTypeScriptAst(sourceLanguage: string, filePath: string): boolean {
        const language = sourceLanguage.toLowerCase();
        if (language === 'typescript' || language === 'javascript') {
            return true;
        }
        return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath);
    }

    private enforceChunkTokenLimit(engine: PortingEngine, file: any, chunks: string[]): string[] {
        const queue = [...chunks];
        const limited: string[] = [];
        const maxLinesToSplit = 24;

        while (queue.length > 0) {
            const candidate = queue.shift();
            if (!candidate || !candidate.trim()) {
                continue;
            }

            const estimatedTokens = engine.estimatePromptTokens(file, {
                overrideContent: candidate,
                chunked: true,
                chunkIndex: 0,
                totalChunks: 1,
                suppressImports: false,
            });

            if (estimatedTokens <= this.maxPromptTokens) {
                limited.push(candidate);
                continue;
            }

            const lines = candidate.split('\n');
            if (lines.length <= maxLinesToSplit) {
                limited.push(candidate);
                continue;
            }

            const mid = Math.floor(lines.length / 2);
            const left = lines.slice(0, mid).join('\n').trim();
            const right = lines.slice(mid).join('\n').trim();
            if (right) queue.unshift(right);
            if (left) queue.unshift(left);
        }

        return limited.length > 0 ? limited : chunks;
    }

    private async splitWithTypeScriptAst(content: string, chunkCount: number, filePath: string): Promise<string[]> {
        const ts = await import('typescript');
        const scriptKind = this.getScriptKind(ts, filePath);
        const sourceFile = ts.createSourceFile(
            filePath || 'source.ts',
            content,
            ts.ScriptTarget.Latest,
            true,
            scriptKind
        );

        const targetSize = Math.max(2000, Math.ceil(content.length / chunkCount));
        const units: string[] = [];

        for (const statement of sourceFile.statements) {
            if (ts.isClassDeclaration(statement) && statement.members.length > 6) {
                units.push(...this.splitClassByMembers(content, statement, targetSize));
            } else {
                const unitText = content
                    .slice(statement.getFullStart(), statement.getEnd())
                    .trim();
                if (unitText.length > 0) {
                    units.push(unitText);
                }
            }
        }

        if (units.length === 0) {
            return this.splitByLineBoundaries(content, chunkCount);
        }

        const chunks: string[] = [];
        let current = '';
        for (const unit of units) {
            if (current.length > 0 && (current.length + unit.length + 2) > targetSize) {
                chunks.push(current.trim());
                current = unit;
            } else {
                current = current.length > 0 ? `${current}\n\n${unit}` : unit;
            }
        }
        if (current.trim().length > 0) {
            chunks.push(current.trim());
        }

        return chunks.length > 0 ? chunks : this.splitByLineBoundaries(content, chunkCount);
    }

    private splitClassByMembers(
        content: string,
        classNode: any,
        targetSize: number
    ): string[] {
        const members = [...classNode.members];
        if (members.length === 0) {
            const wholeClass = content.slice(classNode.getFullStart(), classNode.getEnd()).trim();
            return wholeClass ? [wholeClass] : [];
        }

        const header = content.slice(classNode.getStart(), classNode.members.pos).trimEnd();
        const footer = content.slice(classNode.members.end, classNode.getEnd()).trimStart();
        const memberTexts = members
            .map(member => content.slice(member.getFullStart(), member.getEnd()).trim())
            .filter(Boolean);

        // Method/member-level chunking: one class member per chunk.
        // This is intentional to avoid oversized prompts for large classes.
        return memberTexts.map(memberText => this.buildClassChunk(header, footer, [memberText]));
    }

    private buildClassChunk(header: string, footer: string, members: string[]): string {
        const body = members.join('\n\n');
        return `${header}\n${body}\n${footer}`.trim();
    }

    private getScriptKind(ts: any, filePath: string): any {
        if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
        if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
        if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
            return ts.ScriptKind.JS;
        }
        return ts.ScriptKind.TS;
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
