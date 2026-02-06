/**
 * Execution Planner - Creates detailed execution plans with checkpoints
 */

import type {
    ExecutionPlan,
    ExecutionPhase,
    Checkpoint,
    TaskUnderstanding,
} from '../types/agent-types.js';
import type { DecompositionResult } from './task-decomposer.js';

export interface PlannerOptions {
    enableCheckpoints?: boolean;
    maxParallelTasks?: number;
    qualityThreshold?: number;
}

export class ExecutionPlanner {
    private options: Required<PlannerOptions>;

    constructor(options: PlannerOptions = {}) {
        this.options = {
            enableCheckpoints: options.enableCheckpoints ?? true,
            maxParallelTasks: options.maxParallelTasks ?? 1,
            qualityThreshold: options.qualityThreshold ?? 85,
        };
    }

    /**
     * Create a detailed execution plan from decomposed tasks
     */
    async createPlan(
        decomposition: DecompositionResult,
        understanding: TaskUnderstanding
    ): Promise<ExecutionPlan> {
        const { phases } = decomposition;

        // Optimize phase order based on dependencies
        const optimizedPhases = this.optimizePhaseOrder(phases);

        // Create checkpoints
        const checkpoints = this.options.enableCheckpoints
            ? this.createCheckpoints(optimizedPhases)
            : [];

        // Adjust estimates based on complexity
        const adjustedPhases = this.adjustEstimates(optimizedPhases, understanding);

        return {
            phases: adjustedPhases,
            totalTasks: decomposition.totalTasks,
            estimatedDuration: decomposition.estimatedDuration,
            strategy: understanding.recommendedStrategy,
            checkpoints,
        };
    }

    /**
     * Optimize phase execution order
     */
    private optimizePhaseOrder(phases: ExecutionPhase[]): ExecutionPhase[] {
        // Sort by dependencies - phases with fewer dependencies first
        return [...phases].sort((a, b) => {
            // Analysis phase always first
            if (a.number === 1) return -1;
            if (b.number === 1) return 1;

            // Verification phase always last
            if (a.name === 'Verification') return 1;
            if (b.name === 'Verification') return -1;

            // Sort by dependency count
            return a.dependencies.length - b.dependencies.length;
        });
    }

    /**
     * Create checkpoints for resume capability
     */
    private createCheckpoints(phases: ExecutionPhase[]): Checkpoint[] {
        return phases.map(phase => ({
            id: `checkpoint-${phase.number}`,
            phase: phase.number,
            timestamp: new Date(),
            state: {
                phaseName: phase.name,
                tasksCompleted: 0,
                totalTasks: phase.tasks.length,
            },
            canResume: true,
        }));
    }

    /**
     * Adjust time estimates based on project complexity
     */
    private adjustEstimates(
        phases: ExecutionPhase[],
        understanding: TaskUnderstanding
    ): ExecutionPhase[] {
        const complexityMultiplier = {
            low: 0.8,
            medium: 1.0,
            high: 1.5,
        };

        const multiplier = complexityMultiplier[understanding.complexity];

        return phases.map(phase => ({
            ...phase,
            estimatedDuration: Math.round(phase.estimatedDuration * multiplier),
        }));
    }

    /**
     * Validate plan for consistency
     */
    validatePlan(plan: ExecutionPlan): { valid: boolean; issues: string[] } {
        const issues: string[] = [];

        // Check for circular dependencies
        for (const phase of plan.phases) {
            for (const dep of phase.dependencies) {
                const depPhase = plan.phases.find(p => p.number === dep);
                if (depPhase && depPhase.dependencies.includes(phase.number)) {
                    issues.push(`Circular dependency between phase ${phase.number} and ${dep}`);
                }
            }
        }

        // Check all task dependencies exist
        const allTaskIds = new Set(plan.phases.flatMap(p => p.tasks.map(t => t.id)));
        for (const phase of plan.phases) {
            for (const task of phase.tasks) {
                for (const dep of task.dependencies) {
                    if (dep && !allTaskIds.has(dep) && !dep.startsWith('analyze')) {
                        issues.push(`Task ${task.id} depends on non-existent task ${dep}`);
                    }
                }
            }
        }

        return {
            valid: issues.length === 0,
            issues,
        };
    }

    /**
     * Get plan summary for display
     */
    getPlanSummary(plan: ExecutionPlan): string {
        const lines: string[] = [
            '📋 Execution Plan Summary',
            `Strategy: ${plan.strategy}`,
            `Total Phases: ${plan.phases.length}`,
            `Total Tasks: ${plan.totalTasks}`,
            `Estimated Duration: ${Math.round(plan.estimatedDuration / 60000)}m`,
            '',
            'Phases:',
        ];

        for (const phase of plan.phases) {
            lines.push(`  ${phase.number}. ${phase.name} (${phase.tasks.length} tasks)`);
        }

        return lines.join('\n');
    }
}
