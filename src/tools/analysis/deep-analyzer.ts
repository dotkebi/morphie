/**
 * Deep Analyzer Tool - Enhanced project analysis with detailed insights
 */

import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import { ProjectAnalyzer } from '../../core/analyzer.js';
import type { ProjectMetrics } from '../../types/agent-types.js';

export interface DeepAnalysisResult {
    analysis: any; // Use any to avoid type conflicts with core analyzer
    metrics: ProjectMetrics;
    insights: AnalysisInsight[];
    recommendations: string[];
}

export interface AnalysisInsight {
    category: 'structure' | 'complexity' | 'dependencies' | 'patterns';
    title: string;
    description: string;
    severity: 'info' | 'warning' | 'critical';
}

export class DeepAnalyzer extends BaseTool {
    readonly name = 'deep-analyzer';
    readonly description = 'Performs deep analysis of project structure, dependencies, and patterns';
    readonly category = 'analysis' as const;

    async execute(context: ToolContext): Promise<ToolResult> {
        const startTime = Date.now();

        try {
            this.validateContext(context, ['sourcePath']);

            const sourcePath = context.sourcePath as string;
            const sourceLanguage = context.sourceLanguage as string | undefined;

            // Use existing ProjectAnalyzer
            const analyzer = new ProjectAnalyzer(sourcePath, sourceLanguage);
            const analysis = await analyzer.analyze();

            // Calculate additional metrics
            const metrics = this.calculateMetrics(analysis);

            // Generate insights
            const insights = this.generateInsights(analysis, metrics);

            // Generate recommendations
            const recommendations = this.generateRecommendations(insights);

            const result: DeepAnalysisResult = {
                analysis,
                metrics,
                insights,
                recommendations,
            };

            return {
                ...this.createSuccessResult(result),
                duration: Date.now() - startTime,
            };

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ...this.createFailureResult(`Analysis failed: ${message}`),
                duration: Date.now() - startTime,
            };
        }
    }

    private calculateMetrics(analysis: any): ProjectMetrics {
        const files = analysis.files as any[];
        const totalLines = files.reduce((sum: number, f: any) => sum + f.content.split('\n').length, 0);

        // Simple complexity estimate based on exports and file size
        const avgExportsPerFile = files.length > 0
            ? files.reduce((sum: number, f: any) => sum + f.exports.length, 0) / files.length
            : 0;

        return {
            totalFiles: files.length,
            totalLines,
            averageComplexity: Math.min(10, avgExportsPerFile * 2),
        };
    }

    private generateInsights(
        analysis: any,
        metrics: ProjectMetrics
    ): AnalysisInsight[] {
        const insights: AnalysisInsight[] = [];
        const files = analysis.files as any[];

        // Structure insights
        if (metrics.totalFiles > 100) {
            insights.push({
                category: 'structure',
                title: 'Large Project',
                description: `Project has ${metrics.totalFiles} files, which may require batched processing`,
                severity: 'warning',
            });
        }

        // Complexity insights
        if (metrics.averageComplexity > 5) {
            insights.push({
                category: 'complexity',
                title: 'High Complexity',
                description: 'Files have high average complexity, may need extra attention',
                severity: 'warning',
            });
        }

        // Entry point insights
        if (analysis.entryPoints.length === 0) {
            insights.push({
                category: 'structure',
                title: 'No Entry Points',
                description: 'No clear entry points found, might be a library',
                severity: 'info',
            });
        }

        // Test coverage insights
        const testFiles = files.filter((f: any) => f.type === 'test');
        if (testFiles.length === 0) {
            insights.push({
                category: 'patterns',
                title: 'No Tests',
                description: 'No test files detected in the project',
                severity: 'info',
            });
        }

        // Barrel files
        const barrelFiles = files.filter((f: any) => f.type === 'barrel');
        if (barrelFiles.length > 0) {
            insights.push({
                category: 'patterns',
                title: 'Barrel Files Detected',
                description: `Found ${barrelFiles.length} barrel/index files`,
                severity: 'info',
            });
        }

        return insights;
    }

    private generateRecommendations(insights: AnalysisInsight[]): string[] {
        const recommendations: string[] = [];

        for (const insight of insights) {
            switch (insight.title) {
                case 'Large Project':
                    recommendations.push('Consider using parallel processing for faster porting');
                    break;
                case 'High Complexity':
                    recommendations.push('Manual review recommended for complex files');
                    break;
                case 'No Entry Points':
                    recommendations.push('Verify library exports are correctly identified');
                    break;
                case 'No Tests':
                    recommendations.push('Consider generating test stubs in target language');
                    break;
            }
        }

        return recommendations;
    }
}
