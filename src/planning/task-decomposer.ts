/**
 * Task Decomposer - Breaks down porting tasks into subtasks
 */

import { OllamaClient } from '../llm/ollama.js';
import type {
    PortingTask,
    TaskUnderstanding,
    ExecutionPhase,
    Task,
    SourceFile,
    ProjectAnalysis,
} from '../types/agent-types.js';

export interface DecompositionResult {
    phases: ExecutionPhase[];
    totalTasks: number;
    criticalPath: string[];
    estimatedDuration: number;
}

export class TaskDecomposer {
    private llm: OllamaClient;

    constructor(llm: OllamaClient) {
        this.llm = llm;
    }

    /**
     * Decompose a porting task into phases and subtasks
     */
    async decompose(
        task: PortingTask,
        understanding: TaskUnderstanding,
        analysis?: ProjectAnalysis
    ): Promise<DecompositionResult> {
        const files = analysis?.files || [];

        // Determine strategy based on understanding
        const strategy = this.selectStrategy(understanding, files.length);

        // Create phases based on strategy
        const phases = this.createPhases(strategy, files, task);

        // Calculate critical path and duration
        const criticalPath = this.calculateCriticalPath(phases);
        const estimatedDuration = phases.reduce((sum, p) => sum + p.estimatedDuration, 0);

        return {
            phases,
            totalTasks: phases.reduce((sum, p) => sum + p.tasks.length, 0),
            criticalPath,
            estimatedDuration,
        };
    }

    /**
     * Select decomposition strategy based on project understanding
     */
    private selectStrategy(
        understanding: TaskUnderstanding,
        fileCount: number
    ): 'sequential' | 'dependency-ordered' | 'parallel-batched' {
        // Simple projects: sequential
        if (fileCount <= 10 || understanding.complexity === 'low') {
            return 'sequential';
        }

        // Medium projects: dependency-ordered
        if (fileCount <= 50 || understanding.complexity === 'medium') {
            return 'dependency-ordered';
        }

        // Large projects: parallel batched
        return 'parallel-batched';
    }

    /**
     * Create execution phases based on strategy
     */
    private createPhases(
        strategy: string,
        files: SourceFile[],
        task: PortingTask
    ): ExecutionPhase[] {
        const phases: ExecutionPhase[] = [];

        // Phase 1: Analysis (always required)
        phases.push({
            number: 1,
            name: 'Analysis',
            description: 'Deep analysis of project structure, dependencies, and patterns',
            tasks: [{
                id: 'analyze-project',
                type: 'analyze',
                description: 'Analyze project structure and dependencies',
                files: [task.sourcePath],
                priority: 'critical',
                dependencies: [],
            }],
            dependencies: [],
            optional: false,
            estimatedDuration: 30000,
        });

        // Group files by type/directory for porting phases
        const fileGroups = this.groupFiles(files);
        let phaseNumber = 2;

        // Create porting phases based on file groups
        for (const [groupName, groupFiles] of Object.entries(fileGroups)) {
            if (groupFiles.length === 0) continue;

            const tasks: Task[] = groupFiles.map((file, index) => ({
                id: `port-${phaseNumber}-${index}`,
                type: 'port' as const,
                description: `Port ${file.relativePath}`,
                files: [file.relativePath],
                priority: this.getFilePriority(file),
                dependencies: index === 0 ? ['analyze-project'] : [`port-${phaseNumber}-${index - 1}`],
            }));

            phases.push({
                number: phaseNumber,
                name: `Porting: ${groupName}`,
                description: `Port ${groupFiles.length} ${groupName} files`,
                tasks,
                dependencies: [1],
                optional: false,
                estimatedDuration: groupFiles.length * 15000, // 15s per file estimate
            });

            phaseNumber++;
        }

        // Final verification phase
        phases.push({
            number: phaseNumber,
            name: 'Verification',
            description: 'Verify all ported files for syntax and quality',
            tasks: [{
                id: 'verify-all',
                type: 'verify',
                description: 'Verify all ported files',
                files: [],
                priority: 'high',
                dependencies: phases.slice(1, -1).map(p => p.tasks[p.tasks.length - 1]?.id).filter(Boolean),
            }],
            dependencies: Array.from({ length: phaseNumber - 2 }, (_, i) => i + 2),
            optional: false,
            estimatedDuration: 60000,
        });

        return phases;
    }

    /**
     * Group files by type/directory for organized porting
     */
    private groupFiles(files: SourceFile[]): Record<string, SourceFile[]> {
        const groups: Record<string, SourceFile[]> = {
            'Core': [],
            'Utilities': [],
            'Models': [],
            'Services': [],
            'Tests': [],
            'Other': [],
        };

        for (const file of files) {
            const lowerPath = file.relativePath.toLowerCase();

            if (file.type === 'test') {
                groups['Tests'].push(file);
            } else if (lowerPath.includes('util') || lowerPath.includes('helper')) {
                groups['Utilities'].push(file);
            } else if (lowerPath.includes('model') || lowerPath.includes('type') || lowerPath.includes('interface')) {
                groups['Models'].push(file);
            } else if (lowerPath.includes('service') || lowerPath.includes('api') || lowerPath.includes('client')) {
                groups['Services'].push(file);
            } else if (lowerPath.includes('core') || lowerPath.includes('src/index')) {
                groups['Core'].push(file);
            } else {
                groups['Other'].push(file);
            }
        }

        return groups;
    }

    /**
     * Determine file priority based on characteristics
     */
    private getFilePriority(file: SourceFile): 'low' | 'medium' | 'high' | 'critical' {
        if (file.type === 'barrel' || file.relativePath.includes('index')) {
            return 'low';
        }
        if (file.type === 'test') {
            return 'low';
        }
        if (file.exports.length > 5) {
            return 'high';
        }
        return 'medium';
    }

    /**
     * Calculate critical path through phases
     */
    private calculateCriticalPath(phases: ExecutionPhase[]): string[] {
        // Simplified: just return the longest dependency chain
        return phases.map(p => `Phase ${p.number}: ${p.name}`);
    }
}
