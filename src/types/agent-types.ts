/**
 * Core type definitions for the agent system
 */

// ============================================================================
// Task & Execution Types
// ============================================================================

export interface PortingTask {
  sourcePath: string;
  targetPath: string;
  sourceLanguage: string;
  targetLanguage: string;
  model?: string;
  interactive?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  dartAnalyze?: boolean;
  dartAnalyzeReport?: string;
  dartAnalyzeMarkdownReport?: string;
  dartAnalyzeFailOnWarnings?: boolean;
  dartAnalyzeTopIssues?: number;
  dartAnalyzeRetryThreshold?: number;
  dartAnalyzeMaxRetries?: number;
  dartAnalyzeErrorThreshold?: number;
  dartAnalyzeWarningThreshold?: number;
  dartAnalyzeInfoThreshold?: number;
  resume?: boolean;
  sessionPath?: string;
  refreshUnderstanding?: boolean;
  concurrency?: number;
  autoConcurrency?: boolean;
}

export interface TaskUnderstanding {
  projectType: string;
  challenges: string[];
  criticalFeatures: string[];
  risks: string[];
  recommendedStrategy: string;
  complexity: 'low' | 'medium' | 'high';
}

export interface ExecutionPlan {
  phases: ExecutionPhase[];
  totalTasks: number;
  estimatedDuration: number;
  strategy: string;
  checkpoints: Checkpoint[];
}

export interface ExecutionPhase {
  number: number;
  name: string;
  description: string;
  tasks: Task[];
  dependencies: number[];
  optional: boolean;
  estimatedDuration: number;
}

export interface Task {
  id: string;
  type: 'analyze' | 'port' | 'verify' | 'refine' | 'test';
  description: string;
  files: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  dependencies: string[];
  metadata?: Record<string, any>;
}

export interface Checkpoint {
  id: string;
  phase: number;
  timestamp: Date;
  state: any;
  canResume: boolean;
}

// ============================================================================
// Result Types
// ============================================================================

export interface PortingResult {
  success: boolean;
  phases: PhaseResult[];
  totalFiles: number;
  successCount: number;
  failureCount: number;
  errors: PortingError[];
  qualityScore?: number;
  duration: number;
  report?: PortingReport;
}

export interface PhaseResult {
  phase: number;
  name: string;
  success: boolean;
  filesProcessed: number;
  files: PortedFile[];
  errors: PortingError[];
  duration: number;
  qualityMetrics?: QualityMetrics;
}

export interface PortedFile {
  originalPath: string;
  targetPath: string;
  content: string;
  sourceLanguage: string;
  targetLanguage: string;
  metadata?: {
    linesOfCode: number;
    complexity: number;
    dependencies: string[];
    importIssues?: string[];
    requiredImports?: string[];
    actualImports?: string[];
  };
}

export interface PortingError {
  file?: string;
  phase?: number;
  type: 'syntax' | 'semantic' | 'import' | 'type' | 'runtime' | 'unknown';
  message: string;
  details?: string;
  recoverable: boolean;
  suggestion?: string;
}

// ============================================================================
// Observation & Reflection Types
// ============================================================================

export interface Observation {
  syntaxErrors: SyntaxError[];
  qualityIssues: QualityIssue[];
  suggestions: Suggestion[];
  overallScore: number;
  metrics: QualityMetrics;
}

export interface SyntaxError {
  file: string;
  line?: number;
  column?: number;
  message: string;
  code?: string;
}

export interface QualityIssue {
  file: string;
  type: 'style' | 'performance' | 'maintainability' | 'correctness';
  severity: 'low' | 'medium' | 'high';
  message: string;
  suggestion?: string;
}

export interface Suggestion {
  file: string;
  type: 'refactor' | 'optimize' | 'simplify' | 'modernize';
  description: string;
  impact: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
}

export interface QualityMetrics {
  syntaxCorrectness: number;
  semanticCorrectness: number;
  idiomaticScore: number;
  maintainabilityIndex: number;
  testCoverage?: number;
  overallScore: number;
}

export interface Reflection {
  acceptable: boolean;
  shouldRefine: boolean;
  mainIssues: string[];
  improvements: string[];
  learnings: string[];
  confidence: number;
}

// ============================================================================
// Tool System Types
// ============================================================================

export interface Tool {
  name: string;
  description: string;
  category: 'analysis' | 'porting' | 'verification' | 'refinement';
  execute(context: ToolContext): Promise<ToolResult>;
  canHandle(context: ToolContext): boolean;
}

export interface ToolContext {
  task?: Task;
  phase?: ExecutionPhase;
  file?: any;
  code?: string;
  language?: string;
  targetLanguage?: string;
  conversation?: any;
  projectInfo?: ProjectInfo;
  model?: string;
  [key: string]: any;
}

export interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  metadata?: Record<string, any>;
  duration?: number;
}

// ============================================================================
// Conversation & Memory Types
// ============================================================================

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface Thought {
  type: 'understanding' | 'plan' | 'observation' | 'reflection' | 'decision';
  content: any;
  timestamp: Date;
  phase?: number;
}

export interface ConversationContext {
  messages: Message[];
  thoughts: Thought[];
  learnings: string[];
  currentTask?: PortingTask;
  projectInfo?: ProjectInfo;
}

export interface ProjectInfo {
  projectName: string;
  sourceLanguage: string;
  targetLanguage: string;
  totalFiles: number;
  entryPoints: string[];
  dependencies: string[];
  structure: any;
  patterns: Pattern[];
}

export interface Pattern {
  name: string;
  description: string;
  sourceExample: string;
  targetExample: string;
  frequency: number;
}

// ============================================================================
// Analysis Types
// ============================================================================

export interface ProjectAnalysis {
  language: string;
  files: SourceFile[];
  entryPoints: string[];
  dependencies: Dependency[];
  structure: ProjectStructure;
  metrics: ProjectMetrics;
}

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  type: 'source' | 'test' | 'config' | 'documentation' | 'barrel';
  exports: ExportedSymbol[];
  imports: Import[];
  language: string;
}

export interface ExportedSymbol {
  name: string;
  type: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'variable';
  qualifiedName?: string;
  parentClass?: string;
  isDefault: boolean;
  line?: number;
}

export interface Import {
  path: string;
  symbols: string[];
  isDefault: boolean;
  isDynamic: boolean;
}

export interface Dependency {
  name: string;
  version?: string;
  type: 'production' | 'development';
}

export interface ProjectStructure {
  directories: string[];
  hasTests: boolean;
  hasConfig: boolean;
  hasDocs: boolean;
  depth: number;
}

export interface ProjectMetrics {
  totalFiles: number;
  totalLines: number;
  averageComplexity: number;
  testCoverage?: number;
}

// ============================================================================
// Report Types
// ============================================================================

export interface PortingReport {
  summary: ReportSummary;
  phases: PhaseReport[];
  quality: QualityReport;
  issues: IssueReport[];
  recommendations: string[];
  timestamp: Date;
}

export interface ReportSummary {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  duration: number;
  qualityScore: number;
}

export interface PhaseReport {
  phase: number;
  name: string;
  filesProcessed: number;
  duration: number;
  issues: number;
}

export interface QualityReport {
  metrics: QualityMetrics;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
}

export interface IssueReport {
  file: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  fixed: boolean;
}

// ============================================================================
// Error Recovery Types
// ============================================================================

export interface ErrorAnalysis {
  error: Error;
  type: 'syntax' | 'semantic' | 'import' | 'type' | 'runtime' | 'unknown';
  recoverable: boolean;
  strategy?: RecoveryStrategy;
  confidence: number;
}

export interface RecoveryStrategy {
  name: string;
  description: string;
  steps: string[];
  estimatedSuccess: number;
}
