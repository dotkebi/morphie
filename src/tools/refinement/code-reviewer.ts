/**
 * Code Reviewer Tool - Reviews ported code for quality and issues
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import type { LLMClient } from '../../llm/types.js';
import type { QualityIssue, Suggestion } from '../../types/agent-types.js';

export interface ReviewResult {
    issues: QualityIssue[];
    suggestions: Suggestion[];
    score: number;
    summary: string;
}

export class CodeReviewer extends BaseTool {
    readonly name = 'code-reviewer';
    readonly description = 'Reviews ported code for quality, idioms, and potential issues';
    readonly category = 'refinement' as const;

    private llm: LLMClient;

    constructor(llm: LLMClient) {
        super();
        this.llm = llm;
    }

    async execute(context: ToolContext): Promise<ToolResult> {
        try {
            this.validateContext(context, ['code', 'language']);

            const code = context.code as string;
            const language = context.language as string;
            const originalCode = context.originalCode as string | undefined;

            // Perform static analysis
            const staticIssues = this.performStaticAnalysis(code, language);

            // Get LLM-based review if original code is available
            let llmReview: { issues: QualityIssue[]; suggestions: Suggestion[] } = {
                issues: [],
                suggestions: [],
            };

            if (originalCode) {
                llmReview = await this.getLLMReview(code, originalCode, language);
            }

            // Combine results
            const allIssues = [...staticIssues, ...llmReview.issues];
            const suggestions = llmReview.suggestions;

            // Calculate score
            const score = this.calculateScore(allIssues);

            // Generate summary
            const summary = this.generateSummary(allIssues, suggestions, score);

            const result: ReviewResult = {
                issues: allIssues,
                suggestions,
                score,
                summary,
            };

            return this.createSuccessResult(result);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.createFailureResult(`Review failed: ${message}`);
        }
    }

    /**
     * Perform static analysis checks
     */
    private performStaticAnalysis(code: string, language: string): QualityIssue[] {
        const issues: QualityIssue[] = [];
        const lines = code.split('\n');

        // Check for common issues

        // Long lines
        lines.forEach((line, index) => {
            if (line.length > 120) {
                issues.push({
                    file: 'current',
                    type: 'style',
                    severity: 'low',
                    message: `Line ${index + 1} exceeds 120 characters`,
                });
            }
        });

        // TODO comments left in code
        if (code.includes('TODO') || code.includes('FIXME')) {
            issues.push({
                file: 'current',
                type: 'maintainability',
                severity: 'low',
                message: 'Code contains TODO/FIXME comments',
                suggestion: 'Review and address or remove TODO comments',
            });
        }

        // Console/print statements
        if (language === 'dart' && code.includes('print(')) {
            issues.push({
                file: 'current',
                type: 'correctness',
                severity: 'low',
                message: 'Code contains print statements',
                suggestion: 'Consider using a logging framework instead',
            });
        }

        // Language-specific checks
        switch (language) {
            case 'dart':
                this.checkDartSpecific(code, issues);
                break;
            case 'python':
                this.checkPythonSpecific(code, issues);
                break;
            case 'go':
                this.checkGoSpecific(code, issues);
                break;
        }

        return issues;
    }

    private checkDartSpecific(code: string, issues: QualityIssue[]): void {
        // Check for dynamic type
        if (code.includes('dynamic ') || code.includes(': dynamic')) {
            issues.push({
                file: 'current',
                type: 'correctness',
                severity: 'medium',
                message: 'Code uses dynamic type',
                suggestion: 'Consider using specific types for better type safety',
            });
        }

        // Check for missing const constructors
        const classMatches = code.match(/class\s+\w+/g);
        if (classMatches && !code.includes('const ') && code.includes('final ')) {
            issues.push({
                file: 'current',
                type: 'performance',
                severity: 'low',
                message: 'Classes with final fields could use const constructors',
            });
        }
    }

    private checkPythonSpecific(code: string, issues: QualityIssue[]): void {
        // Check for type hints
        const funcMatches = code.match(/def\s+\w+\([^)]*\)/g);
        if (funcMatches) {
            const hasTypeHints = funcMatches.some(f => f.includes(':'));
            if (!hasTypeHints) {
                issues.push({
                    file: 'current',
                    type: 'maintainability',
                    severity: 'low',
                    message: 'Functions lack type hints',
                    suggestion: 'Add type hints for better code documentation',
                });
            }
        }
    }

    private checkGoSpecific(code: string, issues: QualityIssue[]): void {
        // Check for error handling
        if (code.includes('err :=') && !code.includes('if err != nil')) {
            issues.push({
                file: 'current',
                type: 'correctness',
                severity: 'high',
                message: 'Possible unhandled error',
                suggestion: 'Always check errors in Go',
            });
        }
    }

    /**
     * Get LLM-based code review
     */
    private async getLLMReview(
        code: string,
        originalCode: string,
        language: string
    ): Promise<{ issues: QualityIssue[]; suggestions: Suggestion[] }> {
        const prompt = `
Review this ported ${language} code for quality and correctness.

Original code:
\`\`\`
${originalCode.slice(0, 1000)}
\`\`\`

Ported code:
\`\`\`${language}
${code.slice(0, 2000)}
\`\`\`

Analyze for:
1. Semantic correctness (does it do the same thing?)
2. Idiomatic ${language} patterns
3. Potential bugs or issues
4. Improvements

Respond in JSON:
{
  "issues": [{"type": "correctness|style|performance", "severity": "high|medium|low", "message": "..."}],
  "suggestions": [{"type": "refactor|optimize|simplify", "description": "...", "impact": "high|medium|low"}]
}
`;

        try {
            const response = await this.llm.generate(prompt, { temperature: 0.3 });
            return this.extractJSON(response);
        } catch (error) {
            return { issues: [], suggestions: [] };
        }
    }

    private calculateScore(issues: QualityIssue[]): number {
        let score = 100;

        for (const issue of issues) {
            switch (issue.severity) {
                case 'high':
                    score -= 15;
                    break;
                case 'medium':
                    score -= 5;
                    break;
                case 'low':
                    score -= 2;
                    break;
            }
        }

        return Math.max(0, Math.min(100, score));
    }

    private generateSummary(
        issues: QualityIssue[],
        suggestions: Suggestion[],
        score: number
    ): string {
        const high = issues.filter(i => i.severity === 'high').length;
        const medium = issues.filter(i => i.severity === 'medium').length;
        const low = issues.filter(i => i.severity === 'low').length;

        return `Quality Score: ${score}/100. Issues: ${high} high, ${medium} medium, ${low} low. Suggestions: ${suggestions.length}`;
    }
}
