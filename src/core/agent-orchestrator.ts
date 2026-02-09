/**
 * Agent Orchestrator - Central reasoning engine that coordinates all agent activities
 * Implements the Think → Plan → Act → Observe → Reflect loop
 */

import { OllamaClient } from '../llm/ollama.js';
import { ConversationManager } from '../conversation/conversation-manager.js';
import { ToolRegistry } from '../tools/tool-base.js';
import { DeepAnalyzer } from '../tools/analysis/deep-analyzer.js';
import { FilePorter } from '../tools/porting/file-porter.js';
import { SyntaxChecker } from '../tools/verification/syntax-checker.js';
import { DartAnalyzer } from '../tools/verification/dart-analyzer.js';
import { ProjectAnalyzer } from './analyzer.js';
import { FileSystem } from '../utils/filesystem.js';
import { addDartDependencies, generateProjectFiles } from '../utils/project-config.js';
import { SessionManager, type PortingSession } from '../utils/session.js';
import path from 'path';
import type {
    PortingTask,
    PortingResult,
    TaskUnderstanding,
    ExecutionPlan,
    ExecutionPhase,
    PhaseResult,
    Observation,
    Reflection,
    PortingError,
    QualityMetrics,
    PortedFile,
    QualityIssue,
} from '../types/agent-types.js';
import type { ProjectAnalysis } from './analyzer.js';

export class AgentOrchestrator {
    private llm: OllamaClient;
    private conversation: ConversationManager;
    private toolRegistry: ToolRegistry;
    private verbose: boolean;
    private interactive: boolean;
    private fs: FileSystem;
    private sessionManager: SessionManager;
    private session?: PortingSession;
    private sessionPath?: string;
    private projectAnalysis?: ProjectAnalysis;
    private lastDartAnalyzeSummary?: { errors: number; warnings: number; infos: number };
    private lastDartAnalyzeReportPath?: string;
    private lastDartAnalyzeTotalIssues?: number;
    private lastDartAnalyzeIssueFiles?: string[];
    private lastDartAnalyzeRetryThreshold?: number;
    private lastDartAnalyzeErrorThreshold?: number;
    private lastDartAnalyzeWarningThreshold?: number;
    private lastDartAnalyzeInfoThreshold?: number;
    private lastImportIssueFiles?: string[];
    private refineAttempts = 0;
    private lastPortedFiles?: PortedFile[];
    private lastEmptyResponseFiles?: string[];

    constructor(
        llm: OllamaClient,
        options: {
            verbose?: boolean;
            interactive?: boolean;
        } = {}
    ) {
        this.llm = llm;
        this.conversation = new ConversationManager();
        this.toolRegistry = new ToolRegistry();
        this.verbose = options.verbose ?? false;
        this.interactive = options.interactive ?? false;
        this.fs = new FileSystem();
        this.sessionManager = new SessionManager();

        // Register tools
        this.registerTools();
    }

    /**
     * Register all available tools
     */
    private registerTools(): void {
        this.toolRegistry.register(new DeepAnalyzer());
        this.toolRegistry.register(new FilePorter(this.llm));
        this.toolRegistry.register(new SyntaxChecker());
        this.toolRegistry.register(new DartAnalyzer());
    }

    /**
     * Get the tool registry for registering tools
     */
    getToolRegistry(): ToolRegistry {
        return this.toolRegistry;
    }

    /**
     * Get the conversation manager
     */
    getConversationManager(): ConversationManager {
        return this.conversation;
    }

    /**
     * Main execution loop: Think → Plan → Act → Observe → Reflect
     */
    async execute(task: PortingTask): Promise<PortingResult> {
        this.log('🤖 Agent Orchestrator starting...\n');

        const startTime = Date.now();
        this.conversation.startTask(task);

        try {
            if (task.sessionPath) {
                this.sessionPath = task.sessionPath;
            }
            if (task.resume && this.sessionPath) {
                const loaded = await this.sessionManager.load(this.sessionPath);
                if (loaded) {
                    this.session = loaded;
                }
            }

            // THINK: Understand the task
            this.log('🤔 THINK: Analyzing task...');
            let understanding: TaskUnderstanding;
            if (this.session?.taskUnderstanding && !task.refreshUnderstanding) {
                understanding = this.session.taskUnderstanding;
            } else {
                understanding = await this.think(task);
                if (this.session && this.sessionPath) {
                    this.session.taskUnderstanding = understanding;
                    await this.sessionManager.save(this.sessionPath, this.session);
                }
            }
            this.conversation.addThought('understanding', understanding);
            this.log(`   Project type: ${understanding.projectType}`);
            this.log(`   Complexity: ${understanding.complexity}`);
            this.log(`   Strategy: ${understanding.recommendedStrategy}\n`);

            // PLAN: Create execution strategy
            this.log('📋 PLAN: Creating execution plan...');
            const plan = await this.plan(task, understanding);
            this.conversation.addThought('plan', plan);
            this.log(`   Phases: ${plan.phases.length}`);
            this.log(`   Total tasks: ${plan.totalTasks}`);
            this.log(`   Estimated duration: ${Math.round(plan.estimatedDuration / 60)}m\n`);

            // Show plan to user if interactive
            if (this.interactive) {
                await this.showPlanToUser(plan);
            }

            // ACT: Execute the plan
            this.log('🚀 ACT: Executing plan...\n');
            const result = await this.act(plan, task);

            // OBSERVE: Check results
            this.log('\n👀 OBSERVE: Analyzing results...');
            const observation = await this.observe(result, task);
            this.conversation.addThought('observation', observation);
            this.log(`   Quality score: ${observation.overallScore}/100`);
            this.log(`   Syntax errors: ${observation.syntaxErrors.length}`);
            this.log(`   Quality issues: ${observation.qualityIssues.length}\n`);

            // REFLECT: Learn and improve
            this.log('💭 REFLECT: Evaluating outcomes...');
            const reflection = await this.reflect(observation, result);
            this.conversation.addThought('reflection', reflection);
            this.log(`   Acceptable: ${reflection.acceptable ? 'Yes' : 'No'}`);
            this.log(`   Should refine: ${reflection.shouldRefine ? 'Yes' : 'No'}`);

            // Store learnings
            if (reflection.learnings.length > 0) {
                this.conversation.addLearnings(reflection.learnings);
                this.log(`   Learnings captured: ${reflection.learnings.length}\n`);
            }

            // If reflection suggests improvements, refine
            if (reflection.shouldRefine && !task.dryRun) {
                this.log('\n🔧 REFINE: Improving output...');
                const refined = await this.refine(result, reflection, task);

                // Re-observe after refinement
                const newObservation = await this.observe(refined, task);
                this.log(`   New quality score: ${newObservation.overallScore}/100\n`);

                return this.finalizeResult(refined, startTime);
            }

            return this.finalizeResult(result, startTime);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError(`Execution failed: ${errorMessage}`);

            // Attempt recovery
            if (error instanceof Error) {
                const recovered = await this.attemptRecovery(error, task);
                if (recovered) {
                    return this.finalizeResult(recovered, startTime);
                }
            }

            // Return failure result
            return {
                success: false,
                phases: [],
                totalFiles: 0,
                successCount: 0,
                failureCount: 0,
                errors: [{
                    type: 'unknown',
                    message: errorMessage,
                    recoverable: false,
                }],
                duration: Date.now() - startTime,
            };
        } finally {
            this.conversation.endTask();
        }
    }

    /**
     * THINK: Analyze the task and build understanding
     */
    private async think(task: PortingTask): Promise<TaskUnderstanding> {
        const prompt = `
You are an expert code porting agent. Analyze this porting task:

SOURCE: ${task.sourcePath}
FROM: ${task.sourceLanguage}
TO: ${task.targetLanguage}

Think step-by-step about:
1. What type of project is this likely to be? (library, application, framework, utility, etc.)
2. What are the key challenges in porting from ${task.sourceLanguage} to ${task.targetLanguage}?
3. What language features will need special attention?
4. What are the main risks and potential issues?
5. What's the best strategy for this port?
6. What's the complexity level? (low, medium, high)

Provide your analysis in JSON format:
{
  "projectType": "library|application|framework|utility|other",
  "challenges": ["challenge1", "challenge2", ...],
  "criticalFeatures": ["feature1", "feature2", ...],
  "risks": ["risk1", "risk2", ...],
  "recommendedStrategy": "description of recommended approach",
  "complexity": "low|medium|high"
}

Respond with ONLY the JSON object.
`;

        try {
            const response = await this.llm.generate(prompt, {
                temperature: 0.3,
            });

            return this.extractJSON(response);
        } catch (error) {
            // Fallback to default understanding
            const err = error instanceof Error ? error : undefined;
            this.logError('Failed to generate understanding, using defaults', err);
            return {
                projectType: 'unknown',
                challenges: ['Language syntax differences', 'Type system mapping'],
                criticalFeatures: ['Type conversion', 'Import resolution'],
                risks: ['Semantic differences', 'Missing language features'],
                recommendedStrategy: 'File-by-file porting with dependency ordering',
                complexity: 'medium',
            };
        }
    }

    /**
     * PLAN: Create detailed execution plan
     * For now, creates a simple plan. Will be enhanced with TaskDecomposer later.
     */
    private async plan(
        task: PortingTask,
        understanding: TaskUnderstanding
    ): Promise<ExecutionPlan> {
        // Simple plan for now - will be enhanced in Phase 2
        const phases: ExecutionPhase[] = [
            {
                number: 1,
                name: 'Analysis',
                description: 'Analyze project structure and dependencies',
                tasks: [{
                    id: 'analyze-1',
                    type: 'analyze',
                    description: 'Deep project analysis',
                    files: [task.sourcePath],
                    priority: 'critical',
                    dependencies: [],
                }],
                dependencies: [],
                optional: false,
                estimatedDuration: 30000, // 30s
            },
            {
                number: 2,
                name: 'Porting',
                description: 'Port source files to target language',
                tasks: [{
                    id: 'port-1',
                    type: 'port',
                    description: 'Port all files',
                    files: [],
                    priority: 'high',
                    dependencies: ['analyze-1'],
                }],
                dependencies: [1],
                optional: false,
                estimatedDuration: 300000, // 5m
            },
            {
                number: 3,
                name: 'Verification',
                description: 'Verify ported code quality',
                tasks: [{
                    id: 'verify-1',
                    type: 'verify',
                    description: 'Verify all ported files',
                    files: [],
                    priority: 'high',
                    dependencies: ['port-1'],
                }],
                dependencies: [2],
                optional: false,
                estimatedDuration: 60000, // 1m
            },
        ];

        return {
            phases,
            totalTasks: phases.reduce((sum, p) => sum + p.tasks.length, 0),
            estimatedDuration: phases.reduce((sum, p) => sum + p.estimatedDuration, 0),
            strategy: understanding.recommendedStrategy,
            checkpoints: phases.map(p => ({
                id: `checkpoint-${p.number}`,
                phase: p.number,
                timestamp: new Date(),
                state: {},
                canResume: true,
            })),
        };
    }

    /**
     * ACT: Execute the plan using tools
     */
    private async act(plan: ExecutionPlan, task: PortingTask): Promise<PortingResult> {
        const phaseResults: PhaseResult[] = [];

        for (const phase of plan.phases) {
            this.log(`\n📦 Phase ${phase.number}: ${phase.name}`);
            this.log(`   ${phase.description}`);

            const phaseResult = await this.executePhase(phase, task);
            phaseResults.push(phaseResult);

            if (!phaseResult.success && !phase.optional) {
                this.logError(`Phase ${phase.number} failed, stopping execution`);
                break;
            }

            this.log(`   ✓ Phase complete (${phaseResult.filesProcessed} files, ${phaseResult.duration}ms)`);
        }

        const totalFiles = phaseResults.reduce((sum, r) => sum + r.filesProcessed, 0);
        const successCount = phaseResults.filter(r => r.success).reduce((sum, r) => sum + r.filesProcessed, 0);
        const allErrors = phaseResults.flatMap(r => r.errors);

        return {
            success: allErrors.length === 0,
            phases: phaseResults,
            totalFiles,
            successCount,
            failureCount: totalFiles - successCount,
            errors: allErrors,
            duration: 0, // Will be set in finalizeResult
        };
    }

    /**
     * Execute a single phase using registered tools
     */
    private async executePhase(phase: ExecutionPhase, task: PortingTask): Promise<PhaseResult> {
        const startTime = Date.now();
        const errors: PortingError[] = [];
        let filesProcessed = 0;
        const portedFiles: PortedFile[] = [];

        try {
            // Execute based on phase name
            switch (phase.name) {
                case 'Analysis':
                    await this.executeAnalysisPhase(task);
                    filesProcessed = this.projectAnalysis?.files.length || 0;
                    break;

                case 'Porting':
                    const portingResult = await this.executePortingPhase(task);
                    filesProcessed = portingResult.filesProcessed;
                    portedFiles.push(...portingResult.files);
                    errors.push(...portingResult.errors);
                    await this.generateProjectFilesIfNeeded(task);
                    if (task.targetLanguage === 'dart') {
                        await this.postProcessDartProject(task);
                    }
                    if (task.targetLanguage === 'dart') {
                        await this.writeImportReport(task, portedFiles);
                    }
                    await this.writeEmptyResponseReport(task);
                    break;

                case 'Verification':
                    const verificationResult = await this.executeVerificationPhase(portedFiles, task);
                    filesProcessed = portedFiles.length;
                    errors.push(...verificationResult.errors);
                    break;

                default:
                    this.log(`Unknown phase: ${phase.name}`);
            }

            return {
                phase: phase.number,
                name: phase.name,
                success: errors.length === 0,
                filesProcessed,
                files: portedFiles,
                errors,
                duration: Date.now() - startTime,
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            errors.push({
                type: 'unknown',
                message: errorMessage,
                recoverable: false,
                phase: phase.number,
            });

            return {
                phase: phase.number,
                name: phase.name,
                success: false,
                filesProcessed,
                files: portedFiles,
                errors,
                duration: Date.now() - startTime,
            };
        }
    }

    /**
     * Execute the analysis phase
     */
    private async executeAnalysisPhase(task: PortingTask): Promise<void> {
        this.log('  Analyzing project structure...');

        const analyzer = new ProjectAnalyzer(task.sourcePath, task.sourceLanguage);
        this.projectAnalysis = await analyzer.analyze();

        this.log(`  Found ${this.projectAnalysis.files.length} files to port`);

        if (!this.session && this.sessionPath) {
            this.session = this.sessionManager.createInitial(
                task.sourcePath,
                task.targetPath,
                task.sourceLanguage,
                task.targetLanguage,
                task.model
            );
        }

        if (this.session && this.sessionPath) {
            this.session.analysis = {
                files: this.projectAnalysis.files.length,
                entryPoints: this.projectAnalysis.entryPoints,
                dependencies: this.projectAnalysis.dependencies,
                structure: this.projectAnalysis.structure,
            };
            this.session.totalFiles = this.projectAnalysis.files.length;
            this.session.phase = 'analysis';
            await this.sessionManager.save(this.sessionPath, this.session);
        }
    }

    /**
     * Execute the porting phase
     */
    private async executePortingPhase(
        task: PortingTask,
        onlyFiles?: Set<string>
    ): Promise<{
        filesProcessed: number;
        files: PortedFile[];
        errors: PortingError[];
    }> {
        if (!this.projectAnalysis) {
            throw new Error('Analysis must be completed before porting');
        }

        this.log('  Porting files...');

        const portedFiles: PortedFile[] = [];
        const errors: PortingError[] = [];
        const filePorter = this.toolRegistry.get('file-porter') as FilePorter;

        if (!filePorter) {
            throw new Error('FilePorter tool not found');
        }

        // Build import mapping for the porting engine
        const { PortingEngine } = await import('./porting-engine.js');
        const engine = new PortingEngine(
            this.llm,
            task.sourceLanguage,
            task.targetLanguage,
            this.verbose,
            task.targetPath.split('/').pop() || 'project'
        );
        engine.buildImportMapping(this.projectAnalysis.files);

        if (!task.dryRun && task.targetLanguage === 'dart') {
            await this.fs.removeDirectory(`${task.targetPath}/src`);
        }

        // Port each file
        const completed = new Set(this.session?.completedFiles ?? []);
        const filesToPort = onlyFiles
            ? this.projectAnalysis.files.filter(file => onlyFiles.has(file.relativePath))
            : this.projectAnalysis.files.filter(file => !completed.has(file.relativePath));
        const totalToPort = filesToPort.length;

        for (let i = 0; i < totalToPort; i++) {
            const file = filesToPort[i];
            const progress = `[${i + 1}/${totalToPort}]`;

            this.log(`  ${progress} Porting ${file.relativePath}...`);

            try {
                const result = await filePorter.execute({
                    file,
                    sourceLanguage: task.sourceLanguage,
                    targetLanguage: task.targetLanguage,
                    projectName: task.targetPath.split('/').pop() || 'project',
                    allFiles: this.projectAnalysis.files,
                    verbose: this.verbose,
                });

                if (result.success && result.output?.file) {
                    const ported = result.output.file;
                    portedFiles.push({
                        originalPath: ported.originalPath,
                        targetPath: ported.targetPath,
                        content: ported.content,
                        sourceLanguage: task.sourceLanguage,
                        targetLanguage: task.targetLanguage,
                        metadata: ported.metadata,
                    });

                    // Write file immediately if not dry run
                    if (!task.dryRun) {
                        await this.fs.writeFile(
                            `${task.targetPath}/${ported.targetPath}`,
                            ported.content
                        );
                    }

                    this.log(`  ${progress} ✓ ${file.relativePath} → ${ported.targetPath}`);

                    if (ported.metadata?.importIssues?.length) {
                        errors.push({
                            file: ported.targetPath,
                            type: 'import',
                            message: `Import validation failed: ${ported.metadata.importIssues.join('; ')}`,
                            recoverable: true,
                        });
                    }

                    if (this.session && this.sessionPath) {
                        completed.add(file.relativePath);
                        this.session.completedFiles = Array.from(completed);
                        this.session.phase = 'porting';
                        await this.sessionManager.save(this.sessionPath, this.session);
                    }
                } else {
                    errors.push({
                        file: file.relativePath,
                        type: 'unknown',
                        message: result.error || 'Unknown error',
                        recoverable: true,
                    });
                    this.log(`  ${progress} ✗ Failed: ${file.relativePath}`);
                    if (this.session && this.sessionPath) {
                        this.session.failedFiles.push({
                            file: file.relativePath,
                            error: result.error || 'Unknown error',
                        });
                        this.session.phase = 'porting';
                        await this.sessionManager.save(this.sessionPath, this.session);
                    }

                    if ((result.error || '').includes('Empty response from LLM')) {
                        if (!this.lastEmptyResponseFiles) {
                            this.lastEmptyResponseFiles = [];
                        }
                        this.lastEmptyResponseFiles.push(file.relativePath);
                    }
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                errors.push({
                    file: file.relativePath,
                    type: 'unknown',
                    message: errorMessage,
                    recoverable: false,
                });
                this.log(`  ${progress} ✗ Error: ${file.relativePath}`);
                if (this.session && this.sessionPath) {
                    this.session.failedFiles.push({
                        file: file.relativePath,
                        error: errorMessage,
                    });
                    this.session.phase = 'porting';
                    await this.sessionManager.save(this.sessionPath, this.session);
                }

                if (errorMessage.includes('Empty response from LLM')) {
                    if (!this.lastEmptyResponseFiles) {
                        this.lastEmptyResponseFiles = [];
                    }
                    this.lastEmptyResponseFiles.push(file.relativePath);
                }
            }
        }

        this.lastPortedFiles = portedFiles;
        if (portedFiles.some(file => file.metadata?.importIssues?.length)) {
            this.lastImportIssueFiles = portedFiles
                .filter(file => file.metadata?.importIssues?.length)
                .map(file => file.originalPath);
        } else {
            this.lastImportIssueFiles = undefined;
        }
        return {
            filesProcessed: portedFiles.length,
            files: portedFiles,
            errors,
        };
    }

    private async generateProjectFilesIfNeeded(task: PortingTask): Promise<void> {
        if (task.dryRun) {
            return;
        }

        const projectName = task.targetPath.split('/').pop() || 'project';
        const projectFiles = generateProjectFiles(task.targetLanguage, projectName, task.sourceLanguage);

        if (projectFiles.config) {
            await this.fs.writeFile(
                `${task.targetPath}/${projectFiles.config.filename}`,
                projectFiles.config.content
            );
        }

        await this.fs.writeFile(
            `${task.targetPath}/${projectFiles.gitignore.filename}`,
            projectFiles.gitignore.content
        );
        await this.fs.writeFile(
            `${task.targetPath}/${projectFiles.readme.filename}`,
            projectFiles.readme.content
        );
    }

    private async postProcessDartProject(task: PortingTask): Promise<void> {
        if (task.dryRun || task.targetLanguage !== 'dart') {
            return;
        }

        const libDir = `${task.targetPath}/lib`;
        if (!(await this.fs.directoryExists(libDir))) {
            return;
        }

        const projectName = task.targetPath.split('/').pop() || 'project';
        const engine = new (await import('./porting-engine.js')).PortingEngine(
            this.llm,
            task.sourceLanguage,
            task.targetLanguage,
            this.verbose,
            projectName
        );
        if (this.projectAnalysis) {
            engine.buildImportMapping(this.projectAnalysis.files);
        }

        const files = await this.fs.listFilesRecursive(libDir);
        const externalPackages = new Set<string>();

        for (const filePath of files) {
            if (!filePath.endsWith('.dart')) {
                continue;
            }
            const content = await this.fs.readFile(filePath);
            const relativeTargetPath = path.relative(task.targetPath, filePath).replace(/\\/g, '/');
            const cleaned = engine.finalizeImportsForTarget(content, relativeTargetPath);
            if (cleaned !== content) {
                await this.fs.writeFile(filePath, cleaned);
            }

            const pkgRegex = /import\s+['"]package:([^/]+)\//g;
            let match;
            while ((match = pkgRegex.exec(cleaned)) !== null) {
                const pkg = match[1];
                if (pkg && pkg !== projectName) {
                    externalPackages.add(pkg);
                }
            }
        }

        if (externalPackages.size > 0) {
            const pubspecPath = `${task.targetPath}/pubspec.yaml`;
            if (await this.fs.fileExists(pubspecPath)) {
                const content = await this.fs.readFile(pubspecPath);
                const updated = addDartDependencies(content, Array.from(externalPackages));
                if (updated !== content) {
                    await this.fs.writeFile(pubspecPath, updated);
                }
            }
        }
    }

    /**
     * Execute the verification phase
     */
    private async executeVerificationPhase(
        portedFiles: PortedFile[],
        task: PortingTask
    ): Promise<{
        errors: PortingError[];
    }> {
        this.log('  Verifying ported files...');

        const errors: PortingError[] = [];
        const syntaxChecker = this.toolRegistry.get('syntax-checker') as SyntaxChecker;
        const dartAnalyzer = this.toolRegistry.get('dart-analyzer') as DartAnalyzer;

        if (!syntaxChecker) {
            this.logError('SyntaxChecker tool not found');
            return { errors };
        }

        for (const file of portedFiles) {
            try {
                const result = await syntaxChecker.execute({
                    code: file.content,
                    language: file.targetLanguage,
                    filePath: file.targetPath,
                });

                if (!result.success && result.output?.errors) {
                    for (const err of result.output.errors) {
                        errors.push({
                            file: file.targetPath,
                            type: 'syntax',
                            message: err.message,
                            recoverable: true,
                        });
                    }
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                errors.push({
                    file: file.targetPath,
                    type: 'unknown',
                    message: errorMessage,
                    recoverable: false,
                });
            }
        }

        const shouldRunDartAnalyze =
            task.targetLanguage === 'dart' &&
            !task.dryRun &&
            (task.dartAnalyze ?? true);

        if (shouldRunDartAnalyze && dartAnalyzer) {
            try {
                const reportPath = task.dartAnalyzeReport ?? `${task.targetPath}/morphie-dart-analyze.txt`;
                const markdownPath = task.dartAnalyzeMarkdownReport ?? `${task.targetPath}/morphie-dart-analyze.md`;
                this.lastDartAnalyzeRetryThreshold = task.dartAnalyzeRetryThreshold ?? 1;
                this.lastDartAnalyzeErrorThreshold = task.dartAnalyzeErrorThreshold;
                this.lastDartAnalyzeWarningThreshold = task.dartAnalyzeWarningThreshold;
                this.lastDartAnalyzeInfoThreshold = task.dartAnalyzeInfoThreshold;
                const result = await dartAnalyzer.execute({
                    targetPath: task.targetPath,
                    targetLanguage: task.targetLanguage,
                    reportPath,
                    markdownPath,
                    failOnWarnings: task.dartAnalyzeFailOnWarnings ?? false,
                    topIssues: task.dartAnalyzeTopIssues ?? 10,
                });

                if (result.success && result.output) {
                    const output = result.output as {
                        valid: boolean;
                        skipped: boolean;
                        summary?: { errors: number; warnings: number; infos: number };
                        reportPath?: string;
                        markdownPath?: string;
                        totalIssues?: number;
                        issueFiles?: string[];
                    };

                    if (output.summary) {
                        this.lastDartAnalyzeSummary = output.summary;
                        this.lastDartAnalyzeReportPath = output.reportPath ?? reportPath;
                        this.lastDartAnalyzeTotalIssues = output.totalIssues;
                        this.lastDartAnalyzeIssueFiles = output.issueFiles ?? [];
                    }

                    if (!output.skipped && !output.valid) {
                        errors.push({
                            type: 'syntax',
                            message: `dart analyze reported issues (${output.summary?.errors ?? 0} errors, ${output.summary?.warnings ?? 0} warnings)`,
                            recoverable: true,
                        });
                    }
                } else if (!result.success) {
                    errors.push({
                        type: 'unknown',
                        message: result.error || 'dart analyze failed',
                        recoverable: true,
                    });
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                errors.push({
                    type: 'unknown',
                    message: `dart analyze failed: ${errorMessage}`,
                    recoverable: true,
                });
            }
        }

        return { errors };
    }

    /**
     * OBSERVE: Analyze execution results
     */
    private async observe(result: PortingResult, task: PortingTask): Promise<Observation> {
        const syntaxErrors = result.errors.filter(err => err.type === 'syntax');
        const dartSummary = this.lastDartAnalyzeSummary;
        const dartErrors = dartSummary?.errors ?? 0;
        const dartWarnings = dartSummary?.warnings ?? 0;
        const dartPenalty = Math.min(100, dartErrors * 10 + dartWarnings * 3);
        const totalIssues = this.lastDartAnalyzeTotalIssues ?? 0;

        const syntaxCorrectness = Math.max(0, 100 - syntaxErrors.length * 10 - dartPenalty);
        const semanticCorrectness = Math.max(0, 95 - Math.min(30, Math.floor(result.errors.length / 2)));
        const idiomaticScore = Math.max(0, 85 - Math.min(25, dartWarnings * 2));
        const maintainabilityIndex = 80;
        const overallScore = Math.round(
            (syntaxCorrectness + semanticCorrectness + idiomaticScore + maintainabilityIndex) / 4
        );

        const qualityIssues: QualityIssue[] = [];
        if (dartSummary && (dartSummary.errors > 0 || dartSummary.warnings > 0)) {
            qualityIssues.push({
                file: this.lastDartAnalyzeReportPath ?? task.targetPath,
                type: 'correctness',
                severity: dartSummary.errors > 0 ? 'high' : 'medium',
                message: `dart analyze reported ${dartSummary.errors} errors and ${dartSummary.warnings} warnings`,
                suggestion: 'Review the Dart analyze report and fix reported issues.',
            });
        }

        const metrics: QualityMetrics = {
            syntaxCorrectness,
            semanticCorrectness,
            idiomaticScore,
            maintainabilityIndex,
            overallScore,
        };

        return {
            syntaxErrors: syntaxErrors.map(err => ({
                file: err.file ?? 'unknown',
                message: err.message,
            })),
            qualityIssues,
            suggestions: [],
            overallScore,
            metrics,
        };
    }

    /**
     * REFLECT: Learn from results and decide on improvements
     */
    private async reflect(observation: Observation, result: PortingResult): Promise<Reflection> {
        const acceptable = observation.overallScore >= 85;
        const score = observation.overallScore;
        const dartIssues = this.lastDartAnalyzeTotalIssues ?? 0;
        const importIssues = this.lastImportIssueFiles?.length ?? 0;
        const shouldRefine =
            (score < 90 && score >= 70) ||
            this.shouldRefineFromDart(dartIssues) ||
            importIssues > 0;

        return {
            acceptable,
            shouldRefine,
            mainIssues: observation.qualityIssues.map(i => i.message),
            improvements: observation.suggestions.map(s => s.description),
            learnings: [
                `Quality score achieved: ${observation.overallScore}/100`,
                `Total files processed: ${result.totalFiles}`,
            ],
            confidence: observation.overallScore / 100,
        };
    }

    /**
     * REFINE: Improve output based on reflection
     */
    private async refine(
        result: PortingResult,
        reflection: Reflection,
        task: PortingTask
    ): Promise<PortingResult> {
        const maxRetries = task.dartAnalyzeMaxRetries ?? 1;
        const totalIssues = this.lastDartAnalyzeTotalIssues ?? 0;
        const shouldRefine =
            this.shouldRefineFromDart(totalIssues) ||
            (this.lastImportIssueFiles?.length ?? 0) > 0;

        if (task.targetLanguage !== 'dart' || !shouldRefine) {
            return result;
        }

        if (this.refineAttempts >= maxRetries) {
            return result;
        }

        this.refineAttempts += 1;
        this.log(`🔧 Auto-refine triggered by dart analyze (attempt ${this.refineAttempts}/${maxRetries})`);

        const affectedFiles = this.collectAffectedSourceFiles() ?? this.collectImportIssueFiles();
        const portingResult = await this.executePortingPhase(task, affectedFiles);
        const verificationResult = await this.executeVerificationPhase(portingResult.files, task);

        return {
            success: verificationResult.errors.length === 0,
            phases: [
                {
                    phase: 2,
                    name: 'Porting',
                    success: portingResult.errors.length === 0,
                    filesProcessed: portingResult.filesProcessed,
                    files: portingResult.files,
                    errors: portingResult.errors,
                    duration: 0,
                },
                {
                    phase: 3,
                    name: 'Verification',
                    success: verificationResult.errors.length === 0,
                    filesProcessed: portingResult.filesProcessed,
                    files: portingResult.files,
                    errors: verificationResult.errors,
                    duration: 0,
                },
            ],
            totalFiles: portingResult.filesProcessed,
            successCount: portingResult.filesProcessed - verificationResult.errors.length,
            failureCount: verificationResult.errors.length,
            errors: verificationResult.errors,
            duration: result.duration,
        };
    }

    private shouldRefineFromDart(totalIssues: number): boolean {
        if (!this.lastDartAnalyzeSummary) {
            return false;
        }

        const errorThreshold = this.lastDartAnalyzeErrorThreshold;
        const warningThreshold = this.lastDartAnalyzeWarningThreshold;
        const infoThreshold = this.lastDartAnalyzeInfoThreshold;

        const shouldByTotals = totalIssues >= (this.lastDartAnalyzeRetryThreshold ?? 1);
        const shouldBySeverity =
            (errorThreshold !== undefined && this.lastDartAnalyzeSummary.errors >= errorThreshold) ||
            (warningThreshold !== undefined && this.lastDartAnalyzeSummary.warnings >= warningThreshold) ||
            (infoThreshold !== undefined && this.lastDartAnalyzeSummary.infos >= infoThreshold);

        return shouldBySeverity || shouldByTotals;
    }

    private collectAffectedSourceFiles(): Set<string> | undefined {
        if (!this.lastPortedFiles || !this.lastDartAnalyzeIssueFiles || this.lastDartAnalyzeIssueFiles.length === 0) {
            return undefined;
        }

        const affected = new Set<string>();
        for (const issuePath of this.lastDartAnalyzeIssueFiles) {
            for (const file of this.lastPortedFiles) {
                if (this.matchesIssueFile(issuePath, file.targetPath)) {
                    affected.add(file.originalPath);
                }
            }
        }

        return affected.size > 0 ? affected : undefined;
    }

    private collectImportIssueFiles(): Set<string> | undefined {
        if (!this.lastImportIssueFiles || this.lastImportIssueFiles.length === 0) {
            return undefined;
        }

        return new Set(this.lastImportIssueFiles);
    }

    private matchesIssueFile(issuePath: string, targetPath: string): boolean {
        const normalizedIssue = issuePath.replace(/\\/g, '/');
        const normalizedTarget = targetPath.replace(/\\/g, '/');
        return normalizedIssue === normalizedTarget || normalizedIssue.endsWith(`/${normalizedTarget}`);
    }

    private async writeImportReport(task: PortingTask, portedFiles: PortedFile[]): Promise<void> {
        if (task.dryRun) {
            return;
        }

        const issues = portedFiles
            .filter(file => file.metadata?.importIssues?.length)
            .map(file => ({
                file: file.targetPath,
                issues: file.metadata?.importIssues ?? [],
                required: file.metadata?.requiredImports ?? [],
                actual: file.metadata?.actualImports ?? [],
            }));

        const reportPath = `${task.targetPath}/morphie-import-report.txt`;
        const markdownPath = `${task.targetPath}/morphie-import-report.md`;
        const reportText = this.buildImportReport(issues);
        const reportMarkdown = this.buildImportReportMarkdown(issues);
        await this.fs.writeFile(reportPath, reportText);
        await this.fs.writeFile(markdownPath, reportMarkdown);
    }

    private async writeEmptyResponseReport(task: PortingTask): Promise<void> {
        if (task.dryRun || !this.lastEmptyResponseFiles || this.lastEmptyResponseFiles.length === 0) {
            return;
        }

        const reportPath = `${task.targetPath}/morphie-empty-response.txt`;
        const markdownPath = `${task.targetPath}/morphie-empty-response.md`;
        const lines = [
            'Empty response files:',
            ...this.lastEmptyResponseFiles.map(file => `- ${file}`),
        ];
        const markdownLines = [
            '# Empty Response Report',
            '',
            ...this.lastEmptyResponseFiles.map(file => `- ${file}`),
            '',
        ];

        await this.fs.writeFile(reportPath, lines.join('\n'));
        await this.fs.writeFile(markdownPath, markdownLines.join('\n'));
    }

    private buildImportReport(
        issues: Array<{ file: string; issues: string[]; required: string[]; actual: string[] }>
    ): string {
        if (issues.length === 0) {
            return 'No import issues found.';
        }

        const lines: string[] = [];
        for (const entry of issues) {
            lines.push(`File: ${entry.file}`);
            lines.push('Issues:');
            for (const issue of entry.issues) {
                lines.push(`- ${issue}`);
            }
            if (entry.required.length > 0) {
                lines.push('Required Imports:');
                for (const req of entry.required) {
                    lines.push(`- ${req}`);
                }
            }
            if (entry.actual.length > 0) {
                lines.push('Actual Imports:');
                for (const actual of entry.actual) {
                    lines.push(`- ${actual}`);
                }
            }
            lines.push('');
        }

        return lines.join('\n').trim();
    }

    private buildImportReportMarkdown(
        issues: Array<{ file: string; issues: string[]; required: string[]; actual: string[] }>
    ): string {
        if (issues.length === 0) {
            return '# Import Validation Report\n\nNo import issues found.\n';
        }

        const sections: string[] = ['# Import Validation Report', ''];
        for (const entry of issues) {
            sections.push(`## ${entry.file}`);
            sections.push('');
            sections.push('**Issues**');
            for (const issue of entry.issues) {
                sections.push(`- ${issue}`);
            }
            if (entry.required.length > 0) {
                sections.push('');
                sections.push('**Required Imports**');
                for (const req of entry.required) {
                    sections.push(`- ${req}`);
                }
            }
            if (entry.actual.length > 0) {
                sections.push('');
                sections.push('**Actual Imports**');
                for (const actual of entry.actual) {
                    sections.push(`- ${actual}`);
                }
            }
            sections.push('');
        }

        return sections.join('\n');
    }

    /**
     * Attempt to recover from errors
     */
    private async attemptRecovery(error: Error, task: PortingTask): Promise<PortingResult | null> {
        this.log('🔄 Attempting error recovery...');
        // Placeholder - will be implemented later
        return null;
    }

    /**
     * Finalize the result with duration and metadata
     */
    private finalizeResult(result: PortingResult, startTime: number): PortingResult {
        if (this.session && this.sessionPath) {
            this.session.phase = result.errors.length > 0 ? 'failed' : 'completed';
            void this.sessionManager.save(this.sessionPath, this.session);
        }
        return {
            ...result,
            duration: Date.now() - startTime,
        };
    }

    /**
     * Show plan to user in interactive mode
     */
    private async showPlanToUser(plan: ExecutionPlan): Promise<void> {
        console.log('\n📋 Execution Plan:');
        plan.phases.forEach(phase => {
            console.log(`   Phase ${phase.number}: ${phase.name}`);
            console.log(`   - ${phase.description}`);
            console.log(`   - Tasks: ${phase.tasks.length}`);
        });
        console.log(`\nEstimated duration: ${Math.round(plan.estimatedDuration / 60000)}m`);
        console.log('\nProceed? (Press Enter to continue)');

        // In a real implementation, would wait for user input
        // For now, just continue
    }

    /**
     * Extract JSON from LLM response
     */
    private extractJSON(response: string): any {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to parse JSON: ${message}`);
            }
        }
        throw new Error('No JSON found in response');
    }

    /**
     * Log message if verbose
     */
    private log(message: string): void {
        if (this.verbose) {
            console.log(message);
        }
    }

    /**
     * Log error
     */
    private logError(message: string, error?: Error): void {
        console.error(`❌ ${message}`);
        if (error && this.verbose) {
            console.error(error);
        }
    }
}
