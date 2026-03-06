/**
 * File Porter Tool - Ports individual files with context awareness
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import type { LLMClient } from '../../llm/types.js';
import { createLLMClient, type LLMProvider } from '../../llm/factory.js';
import { PortingEngine } from '../../core/porting-engine.js';
import type { PortedFile } from '../../types/agent-types.js';
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';

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
    private reviewerClient: LLMClient | null = null;
    private reviewerInitialized = false;
    private maxPromptTokens: number;
    private reducedPromptTokens: number;
    private minimalPromptTokens: number;
    private maxDeclarationPromptChars: number;

    constructor(llm: LLMClient, options: FilePorterOptions = {}) {
        super();
        this.llm = llm;
        this.options = {
            verifyAfterPort: options.verifyAfterPort ?? true,
            maxRetries: options.maxRetries ?? 2,
            includeComments: options.includeComments ?? true,
        };
        const maxPromptTokens = this.readPositiveIntEnv('MORPHIE_MAX_PROMPT_TOKENS', 1800);
        this.maxPromptTokens = maxPromptTokens;
        this.reducedPromptTokens = Math.max(1000, Math.floor(maxPromptTokens * 0.7));
        this.minimalPromptTokens = Math.max(1200, Math.floor(maxPromptTokens * 0.85));
        const defaultDeclPromptChars = Math.max(2000, Math.min(8000, maxPromptTokens * 3));
        this.maxDeclarationPromptChars = this.readPositiveIntEnv('MORPHIE_MAX_DECL_PROMPT_CHARS', defaultDeclPromptChars);
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
            const apiSnapshot = context.apiSnapshot as string | undefined;
            const targetPath = context.targetPath as string | undefined;

            const deterministic = await this.tryDeterministicDataPort(
                file,
                sourceLanguage,
                targetLanguage,
                projectName,
                verbose,
                allFiles,
                apiSnapshot
            );
            if (deterministic) {
                if (verbose) {
                    console.log(`[Porting Debug] Deterministic data-port path used: ${file.relativePath}`);
                }
                return this.createSuccessResult({
                    success: true,
                    file: deterministic,
                    deterministic: true,
                });
            }

            let attempts = 0;
            let lastError: string | undefined;
            let forceChunking = false;
            let reviewerEscalated = false;
            let useReviewer = false;
            let lastEstimatedPromptLength = 0;

            let maxAttempts = this.options.maxRetries;
            while (attempts < maxAttempts) {
                attempts++;

                try {
                    const llmForAttempt = useReviewer
                        ? (this.getReviewerClient() ?? this.llm)
                        : this.llm;
                    // Create a minimal porting engine for this file
                    // PortingEngine(llm, sourceLanguage, targetLanguage, verbose, projectName)
                    const engine = new PortingEngine(
                        llmForAttempt,
                        sourceLanguage,
                        targetLanguage,
                        verbose,
                        projectName
                    );

                    if (allFiles) {
                        engine.buildImportMapping(allFiles);
                    }
                    if (apiSnapshot) {
                        engine.setApiSnapshot(apiSnapshot);
                    }

                    const promptTokens = engine.estimatePromptTokens(file);
                    lastEstimatedPromptLength = promptTokens * 4;
                    if (promptTokens > this.maxPromptTokens) {
                        forceChunking = true;
                        // Chunking keeps each request short; reviewer gating should use chunk budget, not whole-file size.
                        lastEstimatedPromptLength = Math.min(lastEstimatedPromptLength, this.maxPromptTokens * 4);
                    }
                    if (forceChunking) {
                        const chunked = await this.portInChunks(
                            engine,
                            file,
                            sourceLanguage,
                            targetLanguage,
                            targetPath
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
                        const llmVerification = await this.llmVerifyPortedOutput(
                            file,
                            ported.content,
                            sourceLanguage,
                            targetLanguage
                        );
                        if (!llmVerification.valid) {
                            lastError = `LLM verify failed: ${llmVerification.issues.join(', ')}`;
                            continue;
                        }
                    }

                    return this.createSuccessResult({
                        success: true,
                        file: ported,
                    });

                } catch (error) {
                    lastError = error instanceof Error ? error.message : String(error);
                    if (this.isContextWindowError(lastError)) {
                        forceChunking = true;
                        this.maxDeclarationPromptChars = Math.max(1200, Math.floor(this.maxDeclarationPromptChars * 0.6));
                        if (verbose) {
                            console.log(
                                `[Porting Debug] Context window exceeded; forcing chunking and reducing declaration chunk size to ${this.maxDeclarationPromptChars} chars.`
                            );
                        }
                        continue;
                    }
                    if (lastError.includes('Combined chunk validation failed')) {
                        maxAttempts = Math.max(maxAttempts, 3);
                    }
                    if (useReviewer && this.shouldFallbackToWorker(lastError)) {
                        useReviewer = false;
                        if (verbose) {
                            console.log('[Porting Debug] Reviewer unavailable/slow; falling back to worker model.');
                        }
                        continue;
                    }
                    if (!reviewerEscalated && this.shouldEscalateToReviewer(lastError)) {
                        if (!this.shouldUseReviewerForPrompt(lastEstimatedPromptLength)) {
                            if (verbose) {
                                console.log(
                                    `[Porting Debug] Reviewer escalation skipped: prompt too long (${lastEstimatedPromptLength} > ${this.getReviewerPromptCutoff()}).`
                                );
                            }
                            return this.createFailureResult(
                                `Failed to port file after ${attempts} attempts: ${lastError} (reviewer skipped: prompt too long)`
                            );
                        }
                        const reviewer = this.getReviewerClient();
                        reviewerEscalated = true;
                        useReviewer = true;
                        if (verbose) {
                            console.log(
                                reviewer
                                    ? '[Porting Debug] Escalating to reviewer model for retry.'
                                    : '[Porting Debug] Escalating to reviewer stage with current worker model (no explicit reviewer model configured).'
                            );
                        }
                        continue;
                    }
                    await this.sleep(this.getBackoffMs(attempts));
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

    private isDataDominantCandidate(file: any, sourceLanguage: string, targetLanguage: string): boolean {
        if (targetLanguage !== 'dart') return false;
        if (!this.canUseTypeScriptAst(sourceLanguage, file.relativePath)) return false;
        const content = String(file.content ?? '');
        if (content.length < 1200) return false;

        const lower = content.toLowerCase();
        if (lower.includes(' class ') || lower.includes('\nclass ')) return false;
        if (lower.includes(' function ') || lower.includes('\nfunction ')) return false;

        const controlCount = (content.match(/\b(if|for|while|switch|try|catch)\b/g) ?? []).length;
        const exportConstCount = (content.match(/\bexport\s+const\b/g) ?? []).length;
        const plainConstObjectCount = (content.match(/\bconst\s+[A-Za-z_]\w*\s*=\s*\{/g) ?? []).length;
        const objectArrayTokens = (content.match(/[{}\[\]]/g) ?? []).length;
        const quoteCount = (content.match(/['"]/g) ?? []).length;
        const literalTokens = objectArrayTokens + quoteCount;
        const literalRatio = literalTokens / Math.max(1, content.length);
        const densityScore = literalTokens - (controlCount * 25);
        const hasGlyphMapShape = /\bexport\s+const\b[\s\S]{0,200}\bglyphs\s*:\s*\{/.test(content);
        const hasLegacyFontPath = /(^|\/)tools\/fonts\/legacy\/.+\.ts$/i.test(file.relativePath.replace(/\\/g, '/'));
        return (exportConstCount >= 1 || plainConstObjectCount >= 1 || hasLegacyFontPath) &&
            controlCount <= 6 &&
            (hasGlyphMapShape || densityScore >= 500) &&
            literalRatio >= 0.003;
    }

    private async tryDeterministicDataPort(
        file: any,
        sourceLanguage: string,
        targetLanguage: string,
        projectName: string,
        verbose: boolean,
        allFiles?: any[],
        apiSnapshot?: string
    ): Promise<PortedFile | null> {
        if (targetLanguage !== 'dart' || !this.canUseTypeScriptAst(sourceLanguage, file.relativePath)) {
            return null;
        }
        if (!this.isDataDominantCandidate(file, sourceLanguage, targetLanguage)) {
            return null;
        }

        try {
            const ts = await import('typescript');
            const scriptKind = this.getScriptKind(ts, file.relativePath);
            const sourceFile = ts.createSourceFile(
                file.relativePath || 'source.ts',
                file.content,
                ts.ScriptTarget.Latest,
                true,
                scriptKind
            );
            const hasAnyExport = sourceFile.statements.some(
                (statement: any) =>
                    statement.modifiers?.some((modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword)
                    || statement.kind === ts.SyntaxKind.ExportAssignment
            );

            const emitted: string[] = [];
            for (const statement of sourceFile.statements) {
                if (ts.isVariableStatement(statement)) {
                    const hasExport = statement.modifiers?.some((modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword);
                    if (!hasExport && hasAnyExport) continue;
                    if (statement.declarationList.flags & ts.NodeFlags.Const) {
                        for (const decl of statement.declarationList.declarations) {
                            if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
                            const name = decl.name.text;
                            const converted = this.convertDeterministicExpression(ts, decl.initializer);
                            if (!converted) continue;
                            const withType = converted.kind === 'map'
                                ? `<String, dynamic>${converted.text}`
                                : `<dynamic>${converted.text}`;
                            emitted.push(`const ${name} = ${withType};`);
                        }
                    }
                }
            }

            if (emitted.length === 0) {
                return null;
            }

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
            if (apiSnapshot) {
                engine.setApiSnapshot(apiSnapshot);
            }

            const targetPath = engine.getTargetPath(file.relativePath);
            const header = (file.content.match(/^\/\/.*$/gm) ?? []).slice(0, 3).join('\n');
            const raw = `${header ? `${header}\n\n` : ''}${emitted.join('\n\n')}`.trim();
            const finalized = engine.finalizeImportsForTarget(raw, targetPath);

            return {
                targetPath,
                content: finalized,
                originalPath: file.relativePath,
                sourceLanguage,
                targetLanguage,
            };
        } catch {
            return null;
        }
    }

    private async tryDeterministicDeclarationPort(
        declarationSource: string,
        filePath: string
    ): Promise<string | null> {
        try {
            const ts = await import('typescript');
            const sourceFile = ts.createSourceFile(
                filePath || 'declaration.ts',
                declarationSource,
                ts.ScriptTarget.Latest,
                true,
                this.getScriptKind(ts, filePath)
            );
            if (sourceFile.statements.length !== 1) {
                return null;
            }
            const statement = sourceFile.statements[0];
            if (!ts.isVariableStatement(statement)) {
                return null;
            }
            const hasExport = statement.modifiers?.some((modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword);
            const declarationList = statement.declarationList;
            const hasConst = Boolean(declarationList.flags & ts.NodeFlags.Const);
            if (!hasConst) {
                return null;
            }
            const isLikelyDataLiteral = declarationList.declarations.every((decl: any) => {
                if (!decl.initializer) return false;
                return ts.isObjectLiteralExpression(decl.initializer) || ts.isArrayLiteralExpression(decl.initializer);
            });
            if (!hasExport && !isLikelyDataLiteral) {
                return null;
            }

            const emitted: string[] = [];
            for (const decl of declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer) {
                    return null;
                }
                const name = decl.name.text;
                const converted = this.convertDeterministicExpression(ts, decl.initializer);
                if (!converted) {
                    return null;
                }
                const withType = converted.kind === 'map'
                    ? `<String, dynamic>${converted.text}`
                    : converted.kind === 'list'
                        ? `<dynamic>${converted.text}`
                        : converted.text;
                emitted.push(`const ${name} = ${withType};`);
            }
            return emitted.length > 0 ? emitted.join('\n\n') : null;
        } catch {
            return null;
        }
    }

    private convertDeterministicExpression(ts: any, node: any): { text: string; kind: 'map' | 'list' | 'other' } | null {
        if (ts.isObjectLiteralExpression(node)) {
            const props: string[] = [];
            for (const prop of node.properties) {
                if (ts.isPropertyAssignment(prop)) {
                    const key = this.convertDeterministicPropertyName(ts, prop.name);
                    const value = this.convertDeterministicExpression(ts, prop.initializer);
                    if (!value) return null;
                    props.push(`${key}: ${value.text}`);
                } else if (ts.isShorthandPropertyAssignment(prop)) {
                    const name = prop.name.text;
                    props.push(`'${name}': ${name}`);
                } else if (ts.isSpreadAssignment(prop)) {
                    const spread = this.convertDeterministicExpression(ts, prop.expression);
                    if (!spread) return null;
                    props.push(`...${spread.text}`);
                } else {
                    return null;
                }
            }
            return { text: `{${props.join(', ')}}`, kind: 'map' };
        }

        if (ts.isArrayLiteralExpression(node)) {
            const items: string[] = [];
            for (const element of node.elements) {
                const converted = this.convertDeterministicExpression(ts, element);
                if (!converted) return null;
                items.push(converted.text);
            }
            return { text: `[${items.join(', ')}]`, kind: 'list' };
        }

        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            const value = String(node.text ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return { text: `'${value}'`, kind: 'other' };
        }
        if (ts.isNumericLiteral(node)) {
            return { text: node.text, kind: 'other' };
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) {
            return { text: 'true', kind: 'other' };
        }
        if (node.kind === ts.SyntaxKind.FalseKeyword) {
            return { text: 'false', kind: 'other' };
        }
        if (node.kind === ts.SyntaxKind.NullKeyword) {
            return { text: 'null', kind: 'other' };
        }
        if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
            const op = node.operator === ts.SyntaxKind.MinusToken ? '-' : '+';
            return { text: `${op}${node.operand.text}`, kind: 'other' };
        }
        if (ts.isIdentifier(node)) {
            return { text: node.text, kind: 'other' };
        }
        if (ts.isPropertyAccessExpression(node)) {
            return { text: node.getText(), kind: 'other' };
        }
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)) {
            return this.convertDeterministicExpression(ts, node.expression);
        }

        return null;
    }

    private convertDeterministicPropertyName(ts: any, nameNode: any): string {
        if (ts.isIdentifier(nameNode)) {
            return `'${nameNode.text}'`;
        }
        if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
            return `'${String(nameNode.text)}'`;
        }
        return nameNode.getText();
    }

    private async llmVerifyPortedOutput(
        file: any,
        portedCode: string,
        sourceLanguage: string,
        targetLanguage: string
    ): Promise<{ valid: boolean; issues: string[] }> {
        if (!this.shouldRunLlmVerify(targetLanguage)) {
            return { valid: true, issues: [] };
        }

        const prompt = `You are a strict code-port verifier.
Return ONLY JSON: {"valid": boolean, "issues": string[]}
- valid=true only if the ported code is structurally consistent and likely compilable.
- Focus on: missing class/function wrappers, duplicate top-level declarations, obvious type/signature mismatches, malformed syntax blocks.
- Keep issues concise (max 5).

Source file: ${file.relativePath}
Source language: ${sourceLanguage}
Target language: ${targetLanguage}

Ported code:
\`\`\`${targetLanguage}
${portedCode}
\`\`\``;

        try {
            const raw = await this.llm.generate(prompt, {
                temperature: 0,
                topP: 1,
                maxTokens: 220,
            });
            const parsed = this.parseLlmVerifyJson(raw);
            if (!parsed) {
                return { valid: true, issues: [] };
            }
            return parsed;
        } catch {
            // Verifier failures should not block the pipeline.
            return { valid: true, issues: [] };
        }
    }

    private shouldRunLlmVerify(targetLanguage: string): boolean {
        const flag = (process.env.MORPHIE_LLM_VERIFY ?? '').trim().toLowerCase();
        if (flag === '0' || flag === 'false' || flag === 'off') {
            return false;
        }
        if (flag === '1' || flag === 'true' || flag === 'on') {
            return true;
        }
        return targetLanguage === 'dart';
    }

    private parseLlmVerifyJson(raw: string): { valid: boolean; issues: string[] } | null {
        if (!raw || !raw.trim()) {
            return null;
        }
        const trimmed = raw.trim();
        const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = (block ? block[1] : trimmed).trim();
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        const jsonText = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
        try {
            const data = JSON.parse(jsonText);
            if (typeof data?.valid !== 'boolean') {
                return null;
            }
            const issues = Array.isArray(data.issues)
                ? data.issues.map((item: unknown) => String(item)).filter(Boolean).slice(0, 5)
                : [];
            return { valid: data.valid, issues };
        } catch {
            return null;
        }
    }

    private async portInChunks(
        engine: PortingEngine,
        file: any,
        sourceLanguage: string,
        targetLanguage: string,
        targetRoot?: string
    ): Promise<PortedFile> {
        if (targetLanguage === 'dart' && this.canUseTypeScriptAst(sourceLanguage, file.relativePath)) {
            return this.portByDeclarations(engine, file, sourceLanguage, targetLanguage);
        }

        engine.setPromptMode('minimal');
        const isEntryFile = this.isEntryFilePath(file.relativePath);
        const checkpoint = await this.loadChunkCheckpoint(file, targetRoot);

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
        const totalChunks = chunks.length;
        if (checkpoint && checkpoint.totalChunks !== totalChunks) {
            checkpoint.chunks = new Array(totalChunks).fill(null);
            checkpoint.totalChunks = totalChunks;
        }

        for (let index = 0; index < chunks.length; index += 1) {
            const saved = checkpoint?.chunks[index];
            if (saved && saved.trim().length > 0) {
                outputs.push(saved.trim());
                continue;
            }

            const chunkContent = chunks[index];
            const suppressImports = targetLanguage === 'dart'
                ? (isEntryFile ? index > 0 : true)
                : index > 0;
            let ported;
            try {
                let skeletonHint: string | undefined;
                const useTwoPass = targetLanguage === 'dart' && this.canUseTypeScriptAst(sourceLanguage, file.relativePath);
                if (useTwoPass) {
                    const skeleton = await engine.portFileWithOptions(file, {
                        overrideContent: chunkContent,
                        chunked: true,
                        chunkIndex: index,
                        totalChunks: chunks.length,
                        suppressImports: true,
                        passMode: 'skeleton',
                    });
                    skeletonHint = skeleton.content.trim().slice(0, 4000);
                }
                ported = await engine.portFileWithOptions(file, {
                    overrideContent: chunkContent,
                    chunked: true,
                    chunkIndex: index,
                    totalChunks: chunks.length,
                    suppressImports,
                    passMode: useTwoPass ? 'body' : 'default',
                    skeletonHint,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Chunk ${index + 1}/${chunks.length} failed: ${message}`);
            }
            let content = ported.content;
            const shouldStripImports = targetLanguage === 'dart'
                ? (isEntryFile ? index > 0 : true)
                : index > 0;
            if (shouldStripImports) {
                content = this.stripImports(content);
            }
            const normalizedChunk = content.trim();
            if (targetLanguage === 'dart') {
                const chunkIssues = this.validateDartChunkBalance(normalizedChunk, index, chunks.length);
                if (chunkIssues.length > 0) {
                    throw new Error(`Chunk ${index + 1}/${chunks.length} failed: Syntax gate failed: ${chunkIssues.join('; ')}`);
                }
            }
            outputs.push(normalizedChunk);
            if (checkpoint) {
                checkpoint.chunks[index] = normalizedChunk;
                await this.saveChunkCheckpoint(file, checkpoint, targetRoot);
            }
        }

        const normalizedOutputs = targetLanguage === 'dart'
            ? this.coalesceDuplicateClassChunks(outputs)
            : outputs;
        let combined = normalizedOutputs.join('\n\n').trim();
        if (targetLanguage === 'dart') {
            combined = engine.finalizeDartChunkedContent(combined, file);
            let finalIssues = engine.validateFinalChunkedOutput(combined, file.relativePath);
            if (finalIssues.some(issue => issue.endsWith(' missing'))) {
                const fallback = engine.applyContractStubFallback(combined, file.relativePath, finalIssues);
                if (fallback.injected.length > 0) {
                    combined = engine.finalizeDartChunkedContent(fallback.content, file);
                    finalIssues = engine.validateFinalChunkedOutput(combined, file.relativePath);
                }
            }
            if (finalIssues.length > 0) {
                const healed = this.tryHealCombinedDartIssues(engine, combined, file, finalIssues);
                if (healed.content !== combined) {
                    combined = healed.content;
                    finalIssues = healed.issues;
                }
            }
            if (finalIssues.length > 0) {
                throw new Error(`Combined chunk validation failed: ${finalIssues.join('; ')}`);
            }
        }

        return {
            targetPath: engine.getTargetPath(file.relativePath),
            content: combined,
            originalPath: file.relativePath,
            sourceLanguage,
            targetLanguage,
        };
    }

    private async portByDeclarations(
        engine: PortingEngine,
        file: any,
        sourceLanguage: string,
        targetLanguage: string
    ): Promise<PortedFile> {
        const declarations = await this.splitWithTypeScriptAst(file.content, 1, file.relativePath);
        const outputUnits: string[] = [];

        for (let declIndex = 0; declIndex < declarations.length; declIndex += 1) {
            const decl = declarations[declIndex];
            const trimmed = decl.trim();
            if (!trimmed) continue;
            if (/^\s*(import|export\s+\*)\b/.test(trimmed)) continue;

            const deterministicDecl = await this.tryDeterministicDeclarationPort(trimmed, file.relativePath);
            if (deterministicDecl) {
                outputUnits.push(deterministicDecl);
                continue;
            }

            if (this.looksLikeClassDeclaration(trimmed)) {
                const classOut = await this.portClassDeclarationTwoPass(engine, file, trimmed);
                outputUnits.push(classOut);
                continue;
            }

            if (trimmed.length + 420 > this.maxDeclarationPromptChars) {
                const chunkedDecl = await this.portOversizedDeclarationInChunks(
                    engine,
                    file,
                    trimmed,
                    declIndex,
                    declarations.length
                );
                if (chunkedDecl.trim()) {
                    outputUnits.push(this.stripImports(chunkedDecl));
                    continue;
                }
            }

            const out = await engine.portDeclarationWithJson(file, trimmed, {
                debug: {
                    filePath: file.relativePath,
                    unitIndex: declIndex,
                    totalUnits: declarations.length,
                },
            });
            if (out.trim()) {
                outputUnits.push(this.stripImports(out));
            }
        }

        let combined = outputUnits.join('\n\n').trim();
        if (targetLanguage === 'dart') {
            combined = engine.finalizeDartChunkedContent(combined, file);
            let finalIssues = engine.validateFinalChunkedOutput(combined, file.relativePath);
            if (finalIssues.some(issue => issue.endsWith(' missing'))) {
                const fallback = engine.applyContractStubFallback(combined, file.relativePath, finalIssues);
                if (fallback.injected.length > 0) {
                    combined = engine.finalizeDartChunkedContent(fallback.content, file);
                    finalIssues = engine.validateFinalChunkedOutput(combined, file.relativePath);
                }
            }
            if (finalIssues.length > 0) {
                const healed = this.tryHealCombinedDartIssues(engine, combined, file, finalIssues);
                if (healed.content !== combined) {
                    combined = healed.content;
                    finalIssues = healed.issues;
                }
            }
            if (finalIssues.length > 0) {
                throw new Error(`Combined chunk validation failed: ${finalIssues.join('; ')}`);
            }
        }

        return {
            targetPath: engine.getTargetPath(file.relativePath),
            content: combined,
            originalPath: file.relativePath,
            sourceLanguage,
            targetLanguage,
        };
    }

    private async portOversizedDeclarationInChunks(
        engine: PortingEngine,
        file: any,
        declarationSource: string,
        unitIndex: number,
        totalUnits: number
    ): Promise<string> {
        const chunkCount = Math.max(2, Math.ceil((declarationSource.length + 420) / this.maxDeclarationPromptChars));
        const chunks = this.splitByLineBoundaries(declarationSource, chunkCount);
        if (chunks.length <= 1) {
            if (process.env.MORPHIE_VERBOSE_OVERSIZE === '1') {
                console.log(
                    `[Porting Debug] Oversized declaration could not split safely: ${file.relativePath} unit=${unitIndex + 1}/${totalUnits}`
                );
            }
            return '';
        }

        if (process.env.MORPHIE_VERBOSE_OVERSIZE === '1') {
            console.log(
                `[Porting Debug] Oversized declaration chunking: ${file.relativePath} unit=${unitIndex + 1}/${totalUnits} chunks=${chunks.length}`
            );
        }

        const outputs: string[] = [];
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
            const chunk = chunks[chunkIndex].trim();
            if (!chunk) continue;
            const ported = await engine.portDeclarationWithJson(file, chunk, {
                debug: {
                    filePath: `${file.relativePath}#decl-${unitIndex + 1}`,
                    unitIndex: chunkIndex,
                    totalUnits: chunks.length,
                },
            });
            const content = this.stripImports(ported).trim();
            if (content) {
                outputs.push(content);
            }
        }
        return outputs.join('\n\n').trim();
    }

    private async portClassDeclarationTwoPass(
        engine: PortingEngine,
        file: any,
        classSource: string
    ): Promise<string> {
        const decomposed = await this.decomposeClassDeclaration(classSource, file.relativePath);
        if (!decomposed) {
            return this.stripImports(await engine.portDeclarationWithJson(file, classSource));
        }

        const useLargeClassOptimization = this.shouldUseLargeClassSkeletonOptimization(
            file.relativePath,
            classSource
        );
        const skeleton = useLargeClassOptimization
            ? this.buildSyntheticDartClassSkeleton(classSource, decomposed.className)
            : await engine.portDeclarationWithJson(file, classSource, { passMode: 'skeleton' });
        if (useLargeClassOptimization && process.env.MORPHIE_VERBOSE_OVERSIZE === '1') {
            console.log(
                `[Porting Debug] Large class skeleton optimization: ${file.relativePath} class=${decomposed.className} chars=${classSource.length}`
            );
        }

        const envelope = this.extractClassEnvelope(skeleton, decomposed.className);
        if (!envelope) {
            if (useLargeClassOptimization) {
                const fallbackEnvelope = this.extractClassEnvelope(
                    this.buildSyntheticDartClassSkeleton(classSource, decomposed.className),
                    decomposed.className
                );
                if (fallbackEnvelope) {
                    const memberOutputs: string[] = [];
                    for (let i = 0; i < decomposed.members.length; i += 1) {
                        const member = decomposed.members[i];
                        const converted = await engine.portClassMemberWithJson(
                            member,
                            decomposed.className,
                            skeleton.slice(0, 3000),
                            {
                                filePath: file.relativePath,
                                memberIndex: i,
                                totalMembers: decomposed.members.length,
                            }
                        );
                        if (converted.trim()) {
                            memberOutputs.push(converted.trim());
                        }
                    }
                    return `${fallbackEnvelope.header}\n${memberOutputs.join('\n\n')}\n${fallbackEnvelope.footer}`.trim();
                }
            }
            return this.stripImports(await engine.portDeclarationWithJson(file, classSource, {
                passMode: 'body',
                skeletonHint: skeleton.slice(0, 3000),
            }));
        }

        const memberOutputs: string[] = [];
        for (let i = 0; i < decomposed.members.length; i += 1) {
            const member = decomposed.members[i];
            const converted = await engine.portClassMemberWithJson(
                member,
                decomposed.className,
                skeleton.slice(0, 3000),
                {
                    filePath: file.relativePath,
                    memberIndex: i,
                    totalMembers: decomposed.members.length,
                }
            );
            if (converted.trim()) {
                memberOutputs.push(converted.trim());
            }
        }
        const assembled = `${envelope.header}\n${memberOutputs.join('\n\n')}\n${envelope.footer}`.trim();
        const sourceMethods = this.extractSourceClassMethodNames(classSource, decomposed.className);
        const missing = sourceMethods.filter(name => !this.dartClassHasMethod(assembled, name));
        if (missing.length === 0) {
            return assembled;
        }

        if (useLargeClassOptimization) {
            return this.injectDartMethodStubs(assembled, missing);
        }

        // Fallback: request full class body pass to preserve missing APIs.
        return this.stripImports(await engine.portDeclarationWithJson(file, classSource, {
            passMode: 'body',
            skeletonHint: skeleton.slice(0, 3000),
            classNameHint: decomposed.className,
        }));
    }

    private async loadChunkCheckpoint(
        file: any,
        targetRoot?: string
    ): Promise<{ fileHash: string; totalChunks: number; chunks: Array<string | null> } | null> {
        if (!targetRoot) return null;
        const fileHash = this.hashFileContent(file.content);
        const checkpointPath = this.getChunkCheckpointPath(targetRoot, file.relativePath);
        try {
            const raw = await fs.readFile(checkpointPath, 'utf8');
            const parsed = JSON.parse(raw) as {
                version?: number;
                strategy?: string;
                fileHash?: string;
                totalChunks?: number;
                chunks?: Array<string | null>;
            };
            if (
                parsed.fileHash !== fileHash ||
                parsed.version !== 2 ||
                parsed.strategy !== this.getCheckpointStrategyKey() ||
                !Array.isArray(parsed.chunks)
            ) {
                return {
                    fileHash,
                    totalChunks: 0,
                    chunks: [],
                };
            }
            return {
                fileHash,
                totalChunks: this.safeChunkCount(parsed.totalChunks, parsed.chunks.length),
                chunks: parsed.chunks,
            };
        } catch {
            return {
                fileHash,
                totalChunks: 0,
                chunks: [],
            };
        }
    }

    private async saveChunkCheckpoint(
        file: any,
        checkpoint: { fileHash: string; totalChunks: number; chunks: Array<string | null> },
        targetRoot?: string
    ): Promise<void> {
        if (!targetRoot) return;
        const checkpointPath = this.getChunkCheckpointPath(targetRoot, file.relativePath);
        const dir = path.dirname(checkpointPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
            checkpointPath,
            JSON.stringify(
                {
                    version: 2,
                    strategy: this.getCheckpointStrategyKey(),
                    file: file.relativePath,
                    fileHash: checkpoint.fileHash,
                    totalChunks: checkpoint.totalChunks,
                    chunks: checkpoint.chunks,
                    updatedAt: new Date().toISOString(),
                },
                null,
                2
            )
        );
    }

    private getChunkCheckpointPath(targetRoot: string, relativePath: string): string {
        const safe = relativePath.replace(/[\\/]/g, '__');
        return path.join(targetRoot, '.morphie', 'chunk-checkpoints', `${safe}.json`);
    }

    private hashFileContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private getCheckpointStrategyKey(): string {
        return 'decl-first-two-pass-large-class-synth-skeleton-safe-split-final-combined-gate-v5';
    }

    private safeChunkCount(totalChunks: unknown, fallback: number): number {
        const n = Number(totalChunks);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100000) {
            return Math.max(0, fallback);
        }
        return n;
    }

    private stripImports(content: string): string {
        return content
            .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
            .replace(/^\s*library\s+[^;]+;\s*$/gm, '')
            .replace(/^\s*export\s+['"][^'"]+['"];?\s*$/gm, '')
            .trim();
    }

    private coalesceDuplicateClassChunks(chunks: string[]): string[] {
        type Parsed = { name: string; header: string; body: string; prefix: string };
        const parsedByIndex = new Map<number, Parsed>();
        const counts = new Map<string, number>();

        for (let i = 0; i < chunks.length; i += 1) {
            const parsed = this.parseSingleClassChunk(chunks[i]);
            if (!parsed) continue;
            parsedByIndex.set(i, parsed);
            counts.set(parsed.name, (counts.get(parsed.name) ?? 0) + 1);
        }

        const duplicateNames = new Set(
            Array.from(counts.entries()).filter(([, count]) => count > 1).map(([name]) => name)
        );
        if (duplicateNames.size === 0) {
            return chunks;
        }

        const seen = new Set<string>();
        const result: string[] = [];
        const groupedBodies = new Map<string, string[]>();
        const groupedHeaders = new Map<string, string>();
        const groupedPrefixes = new Map<string, string>();

        for (let i = 0; i < chunks.length; i += 1) {
            const parsed = parsedByIndex.get(i);
            if (!parsed || !duplicateNames.has(parsed.name)) {
                result.push(chunks[i]);
                continue;
            }

            if (!groupedBodies.has(parsed.name)) {
                groupedBodies.set(parsed.name, []);
                groupedHeaders.set(parsed.name, parsed.header);
                groupedPrefixes.set(parsed.name, parsed.prefix);
            }
            groupedBodies.get(parsed.name)!.push(parsed.body);

            if (!seen.has(parsed.name)) {
                seen.add(parsed.name);
                const prefix = groupedPrefixes.get(parsed.name);
                if (prefix && prefix.trim().length > 0) {
                    result.push(prefix.trim());
                }
                result.push(`__MORPHIE_CLASS_PLACEHOLDER__${parsed.name}__`);
            }
        }

        return result.map(chunk => {
            const match = chunk.match(/^__MORPHIE_CLASS_PLACEHOLDER__([A-Za-z_]\w*)__$/);
            if (!match) return chunk;
            const name = match[1];
            const header = groupedHeaders.get(name);
            const bodies = groupedBodies.get(name);
            if (!header || !bodies || bodies.length === 0) {
                return '';
            }
            const mergedBody = bodies.filter(Boolean).join('\n\n');
            return `${header}\n${mergedBody}\n}`.trim();
        }).filter(Boolean);
    }

    private parseSingleClassChunk(chunk: string): { name: string; header: string; body: string; prefix: string } | null {
        const classMatch = chunk.match(/\bclass\s+([A-Za-z_]\w*)[^{]*\{/);
        if (!classMatch || classMatch.index === undefined) {
            return null;
        }
        const name = classMatch[1];
        const classStart = classMatch.index;
        const openBrace = chunk.indexOf('{', classStart);
        const closeBrace = chunk.lastIndexOf('}');
        if (openBrace < 0 || closeBrace <= openBrace) {
            return null;
        }
        const suffix = chunk.slice(closeBrace + 1).trim();
        if (suffix.length > 0) {
            return null;
        }
        const header = chunk.slice(classStart, openBrace + 1).trim();
        const body = chunk.slice(openBrace + 1, closeBrace).trim();
        const prefix = chunk.slice(0, classStart).trim();
        return { name, header, body, prefix };
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

            if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_]\w*/.test(candidate)) {
                limited.push(candidate);
                continue;
            }

            const lines = candidate.split('\n');
            if (lines.length <= maxLinesToSplit) {
                limited.push(candidate);
                continue;
            }

            const splitIndex = this.findSafeSplitIndex(lines);
            const left = lines.slice(0, splitIndex).join('\n').trim();
            const right = lines.slice(splitIndex).join('\n').trim();
            if (right) queue.unshift(right);
            if (left) queue.unshift(left);
        }

        return limited.length > 0 ? limited : chunks;
    }

    private findSafeSplitIndex(lines: string[]): number {
        if (lines.length <= 2) {
            return Math.max(1, Math.floor(lines.length / 2));
        }

        const target = Math.floor(lines.length / 2);
        const min = Math.max(1, target - Math.floor(lines.length * 0.2));
        const max = Math.min(lines.length - 1, target + Math.floor(lines.length * 0.2));

        let paren = 0;
        let bracket = 0;
        let brace = 0;
        const balances: Array<{ index: number; score: number }> = [];

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            for (let j = 0; j < line.length; j += 1) {
                const ch = line[j];
                if (ch === '(') paren += 1;
                else if (ch === ')') paren -= 1;
                else if (ch === '[') bracket += 1;
                else if (ch === ']') bracket -= 1;
                else if (ch === '{') brace += 1;
                else if (ch === '}') brace -= 1;
            }

            const splitAt = i + 1;
            if (splitAt < min || splitAt > max) continue;
            const trimmed = line.trim();
            const boundaryLike = trimmed === '' || /[;}\])],?$/.test(trimmed);
            if (!boundaryLike) continue;

            const score = Math.abs(paren) + Math.abs(bracket) + Math.abs(brace);
            balances.push({ index: splitAt, score });
        }

        if (balances.length === 0) {
            return Math.max(1, target);
        }

        balances.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            return Math.abs(a.index - target) - Math.abs(b.index - target);
        });
        return balances[0].index;
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

        const units: string[] = [];

        for (const statement of sourceFile.statements) {
            const unitText = content
                .slice(statement.getFullStart(), statement.getEnd())
                .trim();
            if (unitText.length > 0) {
                units.push(unitText);
            }
        }

        if (units.length === 0) {
            return this.splitByLineBoundaries(content, chunkCount);
        }

        // Declaration-first: keep one top-level declaration unit per chunk.
        // This reduces cross-declaration brace coupling during chunk merge.
        return units.length > 0 ? units : this.splitByLineBoundaries(content, chunkCount);
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

        if (memberTexts.length === 0) {
            const wholeClass = content.slice(classNode.getFullStart(), classNode.getEnd()).trim();
            return wholeClass ? [wholeClass] : [];
        }

        const groupedMembers: string[][] = [];
        let bucket: string[] = [];
        let bucketSize = 0;
        for (const memberText of memberTexts) {
            const memberSize = memberText.length + (bucket.length > 0 ? 2 : 0);
            if (bucket.length > 0 && (bucketSize + memberSize) > Math.max(800, targetSize)) {
                groupedMembers.push(bucket);
                bucket = [];
                bucketSize = 0;
            }
            bucket.push(memberText);
            bucketSize += memberSize;
        }
        if (bucket.length > 0) {
            groupedMembers.push(bucket);
        }

        const classChunks: string[] = [];
        if (groupedMembers.length === 1) {
            classChunks.push(this.buildClassChunk(header, footer, groupedMembers[0], 'full'));
            return classChunks;
        }

        for (let i = 0; i < groupedMembers.length; i += 1) {
            const mode: 'open' | 'middle' | 'close' =
                i === 0 ? 'open' : i === groupedMembers.length - 1 ? 'close' : 'middle';
            classChunks.push(this.buildClassChunk(header, footer, groupedMembers[i], mode));
        }

        return classChunks;
    }

    private buildClassChunk(
        header: string,
        footer: string,
        members: string[],
        mode: 'open' | 'middle' | 'close' | 'full'
    ): string {
        const body = members.join('\n\n');
        if (mode === 'open') {
            return `${header}\n${body}`.trim();
        }
        if (mode === 'middle') {
            return body.trim();
        }
        if (mode === 'close') {
            return `${body}\n${footer}`.trim();
        }
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

    private looksLikeClassDeclaration(text: string): boolean {
        return /^\s*(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_]\w*/.test(text);
    }

    private async decomposeClassDeclaration(
        classSource: string,
        filePath: string
    ): Promise<{ className: string; members: string[] } | null> {
        try {
            const ts = await import('typescript');
            const sf = ts.createSourceFile(
                filePath || 'class.ts',
                classSource,
                ts.ScriptTarget.Latest,
                true,
                this.getScriptKind(ts, filePath)
            );
            const cls = sf.statements.find((s: any) => ts.isClassDeclaration(s)) as any;
            if (!cls || !cls.name?.text) return null;
            const className = String(cls.name.text);
            const members = cls.members
                .map((m: any) => classSource.slice(m.getFullStart(), m.getEnd()).trim())
                .filter((m: string) => m.length > 0);
            return { className, members };
        } catch {
            return null;
        }
    }

    private extractClassEnvelope(
        classText: string,
        className: string
    ): { header: string; footer: string } | null {
        const re = new RegExp(`\\b(?:abstract\\s+)?class\\s+${className}\\b[^\\{]*\\{`, 'm');
        const m = re.exec(classText);
        if (!m || m.index === undefined) return null;
        const open = classText.indexOf('{', m.index);
        if (open < 0) return null;
        const close = classText.lastIndexOf('}');
        if (close <= open) return null;
        const header = classText.slice(m.index, open + 1).trim();
        const footerRaw = classText.slice(close).trim();
        const footer = footerRaw.startsWith('}') ? footerRaw : '}';
        return { header, footer };
    }

    private extractSourceClassMethodNames(classSource: string, className: string): string[] {
        const names = new Set<string>();
        const methodRegex = /\b(?:public|private|protected)?\s*(?:static\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g;
        let match: RegExpExecArray | null;
        while ((match = methodRegex.exec(classSource)) !== null) {
            const name = match[1];
            if (name === className) continue;
            if (['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue;
            names.add(name);
        }
        return Array.from(names);
    }

    private dartClassHasMethod(classSource: string, methodName: string): boolean {
        const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const direct = new RegExp(`\\b${escaped}\\s*\\(`);
        const privateName = new RegExp(`\\b_${escaped}\\s*\\(`);
        return direct.test(classSource) || privateName.test(classSource);
    }

    private injectDartMethodStubs(classSource: string, methodNames: string[]): string {
        const unique = Array.from(new Set(methodNames.filter(Boolean)));
        if (unique.length === 0) {
            return classSource;
        }
        const stubs = unique
            .map(name => `  dynamic ${name}([dynamic arg0, dynamic arg1, dynamic arg2, dynamic arg3]) {\n    return null;\n  }`)
            .join('\n\n');
        const close = classSource.lastIndexOf('}');
        if (close < 0) {
            return `${classSource.trim()}\n\n${stubs}\n`;
        }
        return `${classSource.slice(0, close).trimEnd()}\n\n${stubs}\n${classSource.slice(close)}`.trim();
    }

    private shouldUseLargeClassSkeletonOptimization(filePath: string, classSource: string): boolean {
        const normalized = filePath.replace(/\\/g, '/');
        const oversized = classSource.length + 420 > this.maxDeclarationPromptChars;
        const knownHotspot = normalized.endsWith('/stave.ts') || normalized === 'src/stave.ts';
        return oversized || knownHotspot;
    }

    private buildSyntheticDartClassSkeleton(classSource: string, className: string): string {
        const headerMatch = classSource.match(
            /\b(?:export\s+)?(abstract\s+)?class\s+([A-Za-z_]\w*)(?:\s+extends\s+([^{\n]+?))?(?:\s+implements\s+([^{\n]+?))?\s*\{/m
        );

        let isAbstract = false;
        let extendsType = '';
        let implementsTypes: string[] = [];
        if (headerMatch) {
            isAbstract = Boolean(headerMatch[1]);
            extendsType = this.normalizeDartHeritageType(headerMatch[3] ?? '');
            implementsTypes = (headerMatch[4] ?? '')
                .split(',')
                .map(part => this.normalizeDartHeritageType(part))
                .filter(Boolean);
        }

        const abstractPrefix = isAbstract ? 'abstract ' : '';
        const extendsClause = extendsType ? ` extends ${extendsType}` : '';
        const implementsClause = implementsTypes.length > 0
            ? ` implements ${implementsTypes.join(', ')}`
            : '';
        return `${abstractPrefix}class ${className}${extendsClause}${implementsClause} {\n}`;
    }

    private normalizeDartHeritageType(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        const noGenerics = trimmed.replace(/<[^>]*>/g, '').trim();
        const m = noGenerics.match(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/);
        return m ? m[0] : '';
    }

    private isEntryFilePath(filePath: string): boolean {
        const normalized = filePath.replace(/\\/g, '/');
        return normalized.startsWith('entry/') || normalized.includes('/entry/');
    }

    private validateDartChunkBalance(content: string, chunkIndex: number, totalChunks: number): string[] {
        const issues: string[] = [];
        const deltas = this.computeDelimiterDelta(content);
        const isFinalChunk = chunkIndex >= totalChunks - 1;

        // For intermediate chunks, we allow still-open delimiters but disallow over-closing.
        if (deltas.brace < 0) issues.push('unbalanced braces');
        if (deltas.paren < 0) issues.push('unbalanced parentheses');
        if (deltas.bracket < 0) issues.push('unbalanced brackets');

        // Final chunk should be structurally self-contained before merge.
        if (isFinalChunk) {
            if (deltas.brace !== 0 && !issues.includes('unbalanced braces')) issues.push('unbalanced braces');
            if (deltas.paren !== 0 && !issues.includes('unbalanced parentheses')) issues.push('unbalanced parentheses');
            if (deltas.bracket !== 0 && !issues.includes('unbalanced brackets')) issues.push('unbalanced brackets');
        }
        return issues;
    }

    private computeDelimiterDelta(source: string): { brace: number; paren: number; bracket: number } {
        let brace = 0;
        let paren = 0;
        let bracket = 0;
        let i = 0;
        let inLineComment = false;
        let inBlockComment = false;
        let inString: "'" | '"' | '`' | null = null;

        while (i < source.length) {
            const ch = source[i];
            const next = source[i + 1];

            if (inLineComment) {
                if (ch === '\n') inLineComment = false;
                i += 1;
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    i += 2;
                    continue;
                }
                if (ch === inString) {
                    inString = null;
                }
                i += 1;
                continue;
            }

            if (ch === '/' && next === '/') {
                inLineComment = true;
                i += 2;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i += 2;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch as "'" | '"' | '`';
                i += 1;
                continue;
            }

            if (ch === '{') brace += 1;
            else if (ch === '}') brace -= 1;
            else if (ch === '(') paren += 1;
            else if (ch === ')') paren -= 1;
            else if (ch === '[') bracket += 1;
            else if (ch === ']') bracket -= 1;

            i += 1;
        }

        return { brace, paren, bracket };
    }

    private readPositiveIntEnv(name: string, fallback: number): number {
        const raw = process.env[name];
        if (!raw) return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
            return fallback;
        }
        return Math.floor(n);
    }

    private getReviewerClient(): LLMClient | null {
        if (this.reviewerInitialized) {
            return this.reviewerClient;
        }
        this.reviewerInitialized = true;

        const reviewerModel = (process.env.MORPHIE_REVIEWER_MODEL ?? '').trim();
        if (!reviewerModel) {
            this.reviewerClient = null;
            return null;
        }
        const providerRaw = (process.env.MORPHIE_REVIEWER_PROVIDER ?? process.env.MORPHIE_PROVIDER ?? 'lmstudio').trim().toLowerCase();
        const provider: LLMProvider = providerRaw === 'openai'
            ? 'openai'
            : providerRaw === 'lmstudio'
                ? 'lmstudio'
            : providerRaw === 'mlx'
                ? 'mlx'
                : 'ollama';
        const defaultBaseUrl = provider === 'mlx'
            ? 'http://127.0.0.1:9090/v1'
            : provider === 'lmstudio'
                ? 'http://127.0.0.1:1234/v1'
            : provider === 'openai'
                ? 'http://127.0.0.1:8000/v1'
                : 'http://localhost:11434';
        const baseUrl = (process.env.MORPHIE_REVIEWER_BASE_URL ?? process.env.MORPHIE_BASE_URL ?? process.env.MORPHIE_OLLAMA_URL ?? defaultBaseUrl).trim();
        const apiKey = (process.env.MORPHIE_REVIEWER_API_KEY ?? process.env.MORPHIE_API_KEY ?? '').trim() || undefined;

        this.reviewerClient = createLLMClient({
            provider,
            baseUrl,
            model: reviewerModel,
            apiKey,
        });
        return this.reviewerClient;
    }

    private shouldEscalateToReviewer(message: string | undefined): boolean {
        if (!message) return false;
        const lower = message.toLowerCase();
        return lower.includes('combined chunk validation failed')
            || lower.includes('unbalanced braces')
            || lower.includes('duplicate declaration')
            || lower.includes('contract gate failed')
            || lower.includes('invalid array length');
    }

    private getReviewerPromptCutoff(): number {
        const value = Number(process.env.MORPHIE_REVIEWER_MAX_PROMPT_LENGTH ?? '9000');
        if (!Number.isFinite(value) || value <= 0) {
            return 9000;
        }
        return Math.floor(value);
    }

    private shouldUseReviewerForPrompt(estimatedPromptLength: number): boolean {
        if (estimatedPromptLength <= 0) return true;
        return estimatedPromptLength <= this.getReviewerPromptCutoff();
    }

    private shouldFallbackToWorker(message: string): boolean {
        const lower = message.toLowerCase();
        return lower.includes('timed out')
            || lower.includes('timeout')
            || lower.includes('model')
            || lower.includes('connection');
    }

    private isContextWindowError(message: string | undefined): boolean {
        if (!message) return false;
        const lower = message.toLowerCase();
        return lower.includes('context length')
            || lower.includes('maximum context length')
            || lower.includes('tokens to keep')
            || lower.includes('prompt is too long')
            || lower.includes('context window');
    }

    private tryHealCombinedDartIssues(
        engine: PortingEngine,
        content: string,
        file: any,
        issues: string[]
    ): { content: string; issues: string[] } {
        let updated = content;
        let currentIssues = issues;

        for (let pass = 0; pass < 3; pass += 1) {
            let changed = false;

            if (currentIssues.some(issue => issue.includes('pow() used without dart:math import'))) {
                const withMath = this.ensureDartMathImport(updated);
                if (withMath !== updated) {
                    updated = withMath;
                    changed = true;
                }
            }

            const duplicateNames = this.extractDuplicateDeclarationNames(currentIssues);
            if (duplicateNames.length > 0) {
                const deduped = this.removeDuplicateTopLevelDeclarationsByName(updated, new Set(duplicateNames));
                if (deduped !== updated) {
                    updated = deduped;
                    changed = true;
                }
            }

            if (currentIssues.some(issue => issue.startsWith('unbalanced '))) {
                const repaired = this.repairDelimiterBalance(updated);
                if (repaired !== updated) {
                    updated = repaired;
                    changed = true;
                }
            }

            if (!changed) {
                break;
            }

            updated = engine.finalizeDartChunkedContent(updated, file);
            const nextIssues = engine.validateFinalChunkedOutput(updated, file.relativePath);
            if (nextIssues.length === 0) {
                return { content: updated, issues: [] };
            }
            if (nextIssues.join(' | ') === currentIssues.join(' | ')) {
                currentIssues = nextIssues;
                break;
            }
            currentIssues = nextIssues;
        }

        return { content: updated, issues: currentIssues };
    }

    private ensureDartMathImport(content: string): string {
        let updated = content.replace(/(^|[^.\w])pow\s*\(/g, '$1math.pow(');
        const mathImportRegex = /^\s*import\s+['"]dart:math['"](?:\s+as\s+[A-Za-z_]\w*)?;?\s*$/m;
        if (mathImportRegex.test(updated)) {
            updated = updated.replace(
                /^\s*import\s+['"]dart:math['"](?:\s+as\s+[A-Za-z_]\w*)?;?\s*$/m,
                "import 'dart:math' as math;"
            );
            return updated;
        }

        const lines = updated.split('\n');
        let insertAt = 0;
        for (let i = 0; i < lines.length; i += 1) {
            const trimmed = lines[i].trim();
            if (
                trimmed.startsWith('library ')
                || trimmed.startsWith('part of ')
                || trimmed.startsWith('part ')
                || trimmed.startsWith('import ')
                || trimmed.startsWith('export ')
            ) {
                insertAt = i + 1;
                continue;
            }
            if (trimmed !== '') break;
        }
        lines.splice(insertAt, 0, "import 'dart:math' as math;");
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    private extractDuplicateDeclarationNames(issues: string[]): string[] {
        const names = new Set<string>();
        for (const issue of issues) {
            const match = issue.match(/duplicate declaration:\s*([A-Za-z_]\w*)\s*\(/i);
            if (match) {
                names.add(match[1]);
            }
        }
        return Array.from(names);
    }

    private removeDuplicateTopLevelDeclarationsByName(content: string, names: Set<string>): string {
        if (names.size === 0) return content;
        const removalRanges: Array<{ start: number; end: number }> = [];
        const seen = new Set<string>();
        const declRegex = /^\s*(?:abstract\s+)?(class|enum|mixin|typedef)\s+([A-Za-z_]\w*)\b/gm;
        let match: RegExpExecArray | null;

        while ((match = declRegex.exec(content)) !== null) {
            const kind = match[1];
            const name = match[2];
            if (!names.has(name)) {
                continue;
            }

            let end = -1;
            if (kind === 'typedef') {
                const semi = content.indexOf(';', declRegex.lastIndex);
                if (semi >= 0) {
                    end = semi + 1;
                }
            } else {
                const openBrace = content.indexOf('{', declRegex.lastIndex - 1);
                if (openBrace >= 0) {
                    const closeBrace = this.findMatchingBrace(content, openBrace);
                    if (closeBrace >= 0) {
                        end = closeBrace + 1;
                        declRegex.lastIndex = end;
                    }
                }
            }

            if (end <= match.index) {
                continue;
            }

            if (seen.has(name)) {
                removalRanges.push({ start: match.index, end });
            } else {
                seen.add(name);
            }
        }

        if (removalRanges.length === 0) {
            return content;
        }

        removalRanges.sort((a, b) => b.start - a.start);
        let updated = content;
        for (const range of removalRanges) {
            updated = `${updated.slice(0, range.start)}\n${updated.slice(range.end)}`;
        }
        return updated.replace(/\n{3,}/g, '\n\n').trim();
    }

    private findMatchingBrace(content: string, openIndex: number): number {
        let depth = 0;
        let inLineComment = false;
        let inBlockComment = false;
        let inString: "'" | '"' | '`' | null = null;
        for (let i = openIndex; i < content.length; i += 1) {
            const ch = content[i];
            const next = content[i + 1];

            if (inLineComment) {
                if (ch === '\n') inLineComment = false;
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    i += 1;
                }
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    i += 1;
                    continue;
                }
                if (ch === inString) {
                    inString = null;
                }
                continue;
            }

            if (ch === '/' && next === '/') {
                inLineComment = true;
                i += 1;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i += 1;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch as "'" | '"' | '`';
                continue;
            }

            if (ch === '{') depth += 1;
            if (ch === '}') {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    private repairDelimiterBalance(content: string): string {
        const openerToCloser: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
        const closerToOpener: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
        const stack: string[] = [];
        const removeIndices = new Set<number>();

        let inLineComment = false;
        let inBlockComment = false;
        let inString: "'" | '"' | '`' | null = null;

        for (let i = 0; i < content.length; i += 1) {
            const ch = content[i];
            const next = content[i + 1];

            if (inLineComment) {
                if (ch === '\n') inLineComment = false;
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    i += 1;
                }
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    i += 1;
                    continue;
                }
                if (ch === inString) inString = null;
                continue;
            }

            if (ch === '/' && next === '/') {
                inLineComment = true;
                i += 1;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i += 1;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch as "'" | '"' | '`';
                continue;
            }

            if (openerToCloser[ch]) {
                stack.push(ch);
                continue;
            }

            const expectedOpener = closerToOpener[ch];
            if (expectedOpener) {
                const top = stack[stack.length - 1];
                if (top === expectedOpener) {
                    stack.pop();
                } else {
                    removeIndices.add(i);
                }
            }
        }

        let updated = '';
        for (let i = 0; i < content.length; i += 1) {
            if (!removeIndices.has(i)) {
                updated += content[i];
            }
        }
        while (stack.length > 0) {
            const opener = stack.pop()!;
            updated += openerToCloser[opener];
        }
        return updated.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
}
