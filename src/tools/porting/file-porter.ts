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
    private maxPromptTokens = 2200;
    private reducedPromptTokens = 1400;
    private minimalPromptTokens = 1800;

    constructor(llm: LLMClient, options: FilePorterOptions = {}) {
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

            while (attempts < this.options.maxRetries) {
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
                    if (promptTokens > this.maxPromptTokens) {
                        forceChunking = true;
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
                    if (!reviewerEscalated && this.shouldEscalateToReviewer(lastError)) {
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
        const objectArrayTokens = (content.match(/[{}\[\]]/g) ?? []).length;
        const quoteCount = (content.match(/['"]/g) ?? []).length;
        const literalTokens = objectArrayTokens + quoteCount;
        const literalRatio = literalTokens / Math.max(1, content.length);
        const densityScore = literalTokens - (controlCount * 25);
        return exportConstCount >= 1 &&
            controlCount <= 6 &&
            densityScore >= 1400 &&
            literalRatio >= 0.005;
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

            const emitted: string[] = [];
            for (const statement of sourceFile.statements) {
                if (ts.isVariableStatement(statement)) {
                    const hasExport = statement.modifiers?.some((modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword);
                    if (!hasExport) continue;
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

        return { text: node.getText(), kind: 'other' };
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
            const finalIssues = engine.validateFinalChunkedOutput(combined, file.relativePath);
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
        return 'decl-first-two-pass-open-middle-close-safe-split-final-combined-gate-v4';
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

    private isEntryFilePath(filePath: string): boolean {
        const normalized = filePath.replace(/\\/g, '/');
        return normalized.startsWith('entry/') || normalized.includes('/entry/');
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
        const providerRaw = (process.env.MORPHIE_REVIEWER_PROVIDER ?? process.env.MORPHIE_PROVIDER ?? 'ollama').trim().toLowerCase();
        const provider: LLMProvider = providerRaw === 'openai' ? 'openai' : 'ollama';
        const baseUrl = (process.env.MORPHIE_REVIEWER_BASE_URL ?? process.env.MORPHIE_BASE_URL ?? process.env.MORPHIE_OLLAMA_URL ?? 'http://localhost:11434').trim();
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
}
