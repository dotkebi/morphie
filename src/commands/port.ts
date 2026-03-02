import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { ProjectAnalyzer, type SourceFile } from '../core/analyzer.js';
import { PortingEngine } from '../core/porting-engine.js';
import { AgentOrchestrator } from '../core/agent-orchestrator.js';
import { createLLMClient, type LLMProvider } from '../llm/factory.js';
import { FileSystem } from '../utils/filesystem.js';
import { addDartDependencies, generateProjectFiles } from '../utils/project-config.js';
import { orderFilesForPorting } from '../utils/porting-order.js';
import { SessionManager } from '../utils/session.js';

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

interface PortOptions {
  from: string;
  to: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  reviewerModel?: string;
  reviewerProvider?: string;
  reviewerBaseUrl?: string;
  reviewerApiKey?: string;
  ollamaUrl: string;
  dryRun?: boolean;
  verbose?: boolean;
  agent?: boolean;
  interactive?: boolean;
  dartAnalyze?: boolean;
  dartAnalyzeReport?: string;
  dartAnalyzeMd?: string;
  dartAnalyzeFailOnWarnings?: boolean;
  dartAnalyzeTop?: string;
  dartAnalyzeRetryThreshold?: string;
  dartAnalyzeMaxRetries?: string;
  dartAnalyzeErrorThreshold?: string;
  dartAnalyzeWarningThreshold?: string;
  dartAnalyzeInfoThreshold?: string;
  resume?: boolean;
  refreshUnderstanding?: boolean;
  concurrency?: string;
  autoConcurrency?: boolean;
  testMode?: string;
}

type TestMode = 'skip' | 'only';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseTestMode(value: string | undefined): TestMode {
  const mode = (value ?? 'skip').toLowerCase();
  if (mode === 'skip' || mode === 'only') {
    return mode;
  }
  throw new Error(`Invalid --test-mode: ${value}. Use one of: skip, only.`);
}

function parseProvider(value: string | undefined): LLMProvider {
  const provider = (value ?? 'ollama').toLowerCase();
  if (provider === 'ollama' || provider === 'openai') {
    return provider;
  }
  throw new Error(`Invalid --provider: ${value}. Use one of: ollama, openai.`);
}

function selectFilesByTestMode<T extends { type: string }>(files: T[], mode: TestMode): T[] {
  const testFiles = files.filter(file => file.type === 'test');
  const nonTestFiles = files.filter(file => file.type !== 'test');

  switch (mode) {
    case 'only':
      return testFiles;
    case 'skip':
    default:
      return nonTestFiles;
  }
}

function buildApiSnapshot(files: SourceFile[], targetLanguage: string): string {
  if (targetLanguage !== 'dart') {
    return '';
  }

  const coreTargets = new Set([
    'src/element.ts',
    'src/tickable.ts',
    'src/fraction.ts',
    'src/tables.ts',
    'src/typeguard.ts',
    'src/util.ts',
    'src/boundingbox.ts',
    'src/rendercontext.ts',
    'src/stave.ts',
  ]);

  const sections: string[] = [];
  for (const file of files) {
    if (!coreTargets.has(file.relativePath)) continue;
    const symbols = file.exports.map(symbol => `${symbol.type} ${symbol.name}`).slice(0, 20);
    const methodMatches = Array.from(file.content.matchAll(/\b(?:public|private|protected|static\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g))
      .map(match => match[1])
      .filter(name => !['if', 'for', 'while', 'switch', 'catch'].includes(name))
      .slice(0, 30);
    const uniqMethods = Array.from(new Set(methodMatches));
    const lines: string[] = [];
    if (symbols.length > 0) lines.push(`exports: ${symbols.join(', ')}`);
    if (uniqMethods.length > 0) lines.push(`methods: ${uniqMethods.join(', ')}`);
    if (lines.length > 0) sections.push(`- ${file.relativePath}: ${lines.join(' | ')}`);
  }
  return sections.slice(0, 20).join('\n');
}

const execFileAsync = promisify(execFile);

interface DartAnalyzeSummary {
  errors: number;
  warnings: number;
  infos: number;
}

function summarizeDartAnalyze(output: string): DartAnalyzeSummary {
  const summary: DartAnalyzeSummary = { errors: 0, warnings: 0, infos: 0 };
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes(' • ') && line.includes(' error')) {
      summary.errors += 1;
    } else if (line.includes(' • ') && line.includes(' warning')) {
      summary.warnings += 1;
    } else if (line.includes(' • ') && line.includes(' info')) {
      summary.infos += 1;
    }
  }

  return summary;
}

function buildDartAnalyzeMarkdown(
  summary: DartAnalyzeSummary,
  reportPath: string,
  output: string,
  topIssues: number
): string {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(' • '));

  const limited = topIssues > 0 ? lines.slice(0, topIssues) : lines;
  const items = limited.length > 0
    ? limited.map(line => `- ${line}`).join('\n')
    : '- No issues reported.';

  return [
    '# Dart Analyze Report',
    '',
    `Report file: \`${reportPath}\``,
    `Total issues: ${lines.length}`,
    '',
    '## Summary',
    `- Errors: ${summary.errors}`,
    `- Warnings: ${summary.warnings}`,
    `- Infos: ${summary.infos}`,
    '',
    '## Top Issues',
    items,
    lines.length > limited.length ? `\n(Showing top ${limited.length} of ${lines.length} issues)` : '',
    '',
  ].join('\n');
}

async function runDartAnalyze(
  target: string,
  reportPath: string,
  markdownPath: string,
  fs: FileSystem,
  failOnWarnings: boolean,
  topIssues: number,
  verbose?: boolean
): Promise<boolean> {
  try {
    await execFileAsync('dart', ['--version']);
  } catch (error) {
    console.log(chalk.yellow('\n⚠️  Dart SDK not found. Skipping dart analyze.'));
    if (verbose && error instanceof Error) {
      console.log(chalk.gray(`  ${error.message}`));
    }
    return false;
  }

  console.log(chalk.cyan('\n🔍 Running: dart analyze'));
  try {
    const result = await execFileAsync('dart', ['analyze'], {
      cwd: target,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output) {
      console.log(output);
    }
    await fs.writeFile(reportPath, output || 'No issues reported.');
    const summary = summarizeDartAnalyze(output);
    const markdown = buildDartAnalyzeMarkdown(summary, reportPath, output, topIssues);
    await fs.writeFile(markdownPath, markdown);
    console.log(chalk.gray(`Report: ${reportPath}`));
    console.log(chalk.gray(`Markdown: ${markdownPath}`));
    console.log(chalk.gray(`Summary: ${summary.errors} errors, ${summary.warnings} warnings, ${summary.infos} infos`));
    const valid = summary.errors === 0 && (!failOnWarnings || summary.warnings === 0);
    if (valid) {
      console.log(chalk.green('✅ dart analyze completed with no errors.'));
    } else {
      console.log(chalk.red('❌ dart analyze reported issues.'));
    }
    return valid;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    if (output) {
      console.log(output);
    }
    await fs.writeFile(reportPath, output || 'dart analyze failed with no output.');
    const summary = summarizeDartAnalyze(output);
    const markdown = buildDartAnalyzeMarkdown(summary, reportPath, output, topIssues);
    await fs.writeFile(markdownPath, markdown);
    console.log(chalk.gray(`Report: ${reportPath}`));
    console.log(chalk.gray(`Markdown: ${markdownPath}`));
    console.log(chalk.gray(`Summary: ${summary.errors} errors, ${summary.warnings} warnings, ${summary.infos} infos`));
    console.log(chalk.red('❌ dart analyze reported issues.'));
    if (verbose && err.message) {
      console.log(chalk.gray(`  ${err.message}`));
    }
    return false;
  }
}

export async function portProject(
  source: string,
  target: string,
  options: PortOptions
): Promise<void> {
  console.log(chalk.blue.bold('\n🍴 Morphie - Project Porting Tool\n'));

  const spinner = ora('Initializing...').start();

  try {
    const provider = parseProvider(options.provider);
    const baseUrl = options.baseUrl ?? options.ollamaUrl;
    const reviewerProvider = parseProvider(options.reviewerProvider ?? options.provider);
    const reviewerBaseUrl = options.reviewerBaseUrl ?? options.baseUrl ?? options.ollamaUrl;
    const reviewerModel = options.reviewerModel?.trim() || 'deepseek-r1:70b';
    const reviewerApiKey = options.reviewerApiKey ?? options.apiKey;
    process.env.MORPHIE_REVIEWER_MODEL = reviewerModel;
    process.env.MORPHIE_REVIEWER_PROVIDER = reviewerProvider;
    process.env.MORPHIE_REVIEWER_BASE_URL = reviewerBaseUrl;
    if (reviewerApiKey) {
      process.env.MORPHIE_REVIEWER_API_KEY = reviewerApiKey;
    }
    const testMode = parseTestMode(options.testMode);
    const sessionManager = new SessionManager();
    const sessionPath = `${target}/.morphie/session.json`;
    const loadedSession = await sessionManager.load(sessionPath);
    const shouldResume = options.resume !== false && loadedSession !== null;
    const existingSession = shouldResume ? loadedSession : null;
    if (options.resume && !existingSession) {
      spinner.fail('Resume requested but no session found.');
      process.exit(1);
    }

    if (existingSession) {
      const mismatch =
        existingSession.sourcePath !== source ||
        existingSession.targetPath !== target ||
        existingSession.sourceLanguage !== options.from ||
        existingSession.targetLanguage !== options.to;
      if (mismatch) {
        spinner.fail('Session does not match current source/target/language options.');
        process.exit(1);
      }
    }

    // Validate source directory
    spinner.text = 'Validating source directory...';
    const fs = new FileSystem();
    if (!(await fs.directoryExists(source))) {
      spinner.fail('Source directory does not exist');
      process.exit(1);
    }

    // Initialize LLM client
    spinner.text = `Connecting to ${provider} endpoint...`;
    const llm = createLLMClient({
      provider,
      baseUrl,
      model: options.model,
      apiKey: options.apiKey,
    });
    const isConnected = await llm.healthCheck();
    if (!isConnected) {
      spinner.fail(`Cannot connect to ${provider} endpoint: ${baseUrl}`);
      process.exit(1);
    }

    const initialSession = existingSession ?? sessionManager.createInitial(
      source,
      target,
      options.from,
      options.to,
      options.model
    );
    if (!initialSession.fileHashes) {
      initialSession.fileHashes = {};
    }
    await sessionManager.save(sessionPath, initialSession);

    // Use Agent mode by default (can be disabled with --no-agent)
    if (options.agent !== false) {
      spinner.succeed('Agent mode enabled');
      console.log(chalk.magenta('\n🤖 Running with Agent Orchestrator...\n'));

      const orchestrator = new AgentOrchestrator(llm, {
        verbose: options.verbose,
        interactive: options.interactive,
      });

      const result = await orchestrator.execute({
        sourcePath: source,
        targetPath: target,
        sourceLanguage: options.from,
        targetLanguage: options.to,
        model: options.model,
        dryRun: options.dryRun,
        verbose: options.verbose,
        dartAnalyze: options.dartAnalyze,
        dartAnalyzeReport: options.dartAnalyzeReport,
        dartAnalyzeMarkdownReport: options.dartAnalyzeMd,
        dartAnalyzeFailOnWarnings: options.dartAnalyzeFailOnWarnings,
        dartAnalyzeTopIssues: parsePositiveInt(options.dartAnalyzeTop, 10),
        dartAnalyzeRetryThreshold: parsePositiveInt(options.dartAnalyzeRetryThreshold, 1),
        dartAnalyzeMaxRetries: parsePositiveInt(options.dartAnalyzeMaxRetries, 1),
        dartAnalyzeErrorThreshold: options.dartAnalyzeErrorThreshold !== undefined
          ? parseNonNegativeInt(options.dartAnalyzeErrorThreshold, 0)
          : undefined,
        dartAnalyzeWarningThreshold: options.dartAnalyzeWarningThreshold !== undefined
          ? parseNonNegativeInt(options.dartAnalyzeWarningThreshold, 0)
          : undefined,
        dartAnalyzeInfoThreshold: options.dartAnalyzeInfoThreshold !== undefined
          ? parseNonNegativeInt(options.dartAnalyzeInfoThreshold, 0)
          : undefined,
        resume: shouldResume,
        sessionPath,
        refreshUnderstanding: options.refreshUnderstanding,
        concurrency: parsePositiveInt(options.concurrency, 2),
        autoConcurrency: options.autoConcurrency,
        testMode,
      });

      if (result.success) {
        console.log(chalk.green(`\n✅ Agent completed successfully!`));
        console.log(`  Total files: ${chalk.cyan(result.totalFiles)}`);
        console.log(`  Success: ${chalk.green(result.successCount)}`);
        console.log(`  Failed: ${chalk.red(result.failureCount)}`);
        console.log(`  Duration: ${chalk.yellow(formatTime(Math.round(result.duration / 1000)))}`);
        if (result.qualityScore) {
          console.log(`  Quality score: ${chalk.cyan(result.qualityScore + '/100')}`);
        }
      } else {
        console.log(chalk.red(`\n❌ Agent encountered errors:`));
        result.errors.forEach(err => {
          console.log(chalk.red(`  - ${err.message}`));
        });
      }
      return;
    }

    // Analyze source project
    spinner.text = 'Analyzing source project...';
    const analyzer = new ProjectAnalyzer(source, options.from);
    const analysis = await analyzer.analyze();

    const session = existingSession ?? sessionManager.createInitial(
      source,
      target,
      options.from,
      options.to,
      options.model
    );
    if (!session.fileHashes) {
      session.fileHashes = {};
    }
    session.analysis = {
      files: analysis.files.length,
      entryPoints: analysis.entryPoints,
      dependencies: analysis.dependencies,
      structure: analysis.structure,
    };
    session.totalFiles = analysis.files.length;
    session.phase = 'analysis';
    await sessionManager.save(sessionPath, session);

    if (options.verbose) {
      console.log(chalk.gray(`  Reviewer model: ${reviewerModel}`));
      console.log(chalk.gray(`  Reviewer provider: ${reviewerProvider}`));
      console.log(chalk.gray(`  Reviewer base URL: ${reviewerBaseUrl}`));
      spinner.stop();
      console.log(chalk.gray('\nProject Analysis:'));
      console.log(chalk.gray(`  Files: ${analysis.files.length}`));
      console.log(chalk.gray(`  Language: ${analysis.language}`));
      console.log(chalk.gray(`  Entry points: ${analysis.entryPoints.join(', ') || 'None detected'}`));
      spinner.start();
    }

    if (options.dryRun) {
      spinner.succeed('Dry run completed. Analysis:');
      console.log(chalk.cyan('\nSource Project:'));
      console.log(`  Language: ${chalk.yellow(analysis.language)}`);
      console.log(`  Files to port: ${chalk.yellow(analysis.files.length)}`);
      console.log(`  Target language: ${chalk.green(options.to)}`);
      return;
    }

    // Create target directory
    spinner.text = 'Creating target directory...';
    await fs.ensureDirectory(target);
    if (options.to === 'dart') {
      await fs.removeDirectory(`${target}/src`);
    }

    // Port the project
    spinner.text = 'Building import mapping...';
    const projectName = path.basename(target);
    const engine = new PortingEngine(llm, options.from, options.to, options.verbose, projectName);

    // Build import mapping before porting
    engine.buildImportMapping(analysis.files);
    const apiSnapshot = buildApiSnapshot(analysis.files, options.to);
    if (apiSnapshot) {
      engine.setApiSnapshot(apiSnapshot);
    }

    spinner.stop();

    const selectedFiles = orderFilesForPorting(
      selectFilesByTestMode(analysis.files, testMode),
      options.from,
      options.to
    );
    const totalFiles = selectedFiles.length;
    console.log(chalk.cyan(`\nPorting ${totalFiles} files:\n`));

    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();
    const importIssues: Array<{ file: string; issues: string[]; required: string[]; actual: string[] }> = [];
    const completed = new Set(existingSession?.completedFiles ?? []);
    const fileHashes = existingSession?.fileHashes ?? {};
    const baseConcurrency = parsePositiveInt(options.concurrency, 2);
    const autoConcurrency = options.autoConcurrency !== false;
    const semaphore = new AdaptiveSemaphore(baseConcurrency);
    let processed = 0;
    const files = selectedFiles;
    let skippedCount = 0;

    const resumableCount = files.reduce((count, file) => {
      const contentHash = crypto.createHash('sha256').update(file.content).digest('hex');
      return completed.has(file.relativePath) && fileHashes[file.relativePath] === contentHash
        ? count + 1
        : count;
    }, 0);
    if (resumableCount > 0) {
      console.log(chalk.gray(`Resuming session: ${resumableCount} files will be skipped (already completed).`));
    }

    const tasks = files.map(async file => {
      const contentHash = crypto.createHash('sha256').update(file.content).digest('hex');
      if (completed.has(file.relativePath) && fileHashes[file.relativePath] === contentHash) {
        skippedCount++;
        return;
      }

      await semaphore.acquire();
      const progress = `[${processed + 1}/${totalFiles}]`;
      const percent = Math.round(((processed + 1) / totalFiles) * 100);
      const fileSpinner = ora(`${progress} ${percent}% Porting ${file.relativePath}...`).start();

      try {
        session.failedFiles = session.failedFiles.filter(item => item.file !== file.relativePath);
        const result = await engine.portFile(file);
        await fs.writeFile(
          `${target}/${result.targetPath}`,
          result.content
        );
        if (result.metadata?.importIssues && result.metadata.importIssues.length > 0) {
          importIssues.push({
            file: result.targetPath,
            issues: result.metadata.importIssues,
            required: result.metadata.requiredImports ?? [],
            actual: result.metadata.actualImports ?? [],
          });
        }
        completed.add(file.relativePath);
        fileHashes[file.relativePath] = contentHash;
        session.completedFiles = Array.from(completed);
        session.fileHashes = fileHashes;
        session.phase = 'porting';
        await sessionManager.save(sessionPath, session);
        fileSpinner.succeed(`${progress} ${file.relativePath} → ${result.targetPath}`);
        successCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fileSpinner.fail(`${progress} Failed: ${file.relativePath}`);
        if (options.verbose && error instanceof Error) {
          console.log(chalk.red(`  Error: ${error.message}`));
        }
        failCount++;
        session.failedFiles = session.failedFiles.filter(item => item.file !== file.relativePath);
        session.failedFiles.push({
          file: file.relativePath,
          error: message,
        });
        session.phase = 'porting';
        await sessionManager.save(sessionPath, session);

        if (message.includes('Empty response from LLM')) {
          await appendEmptyResponse(target, file.relativePath, fs);
          if (autoConcurrency && semaphore.getLimit() > 1) {
            semaphore.setLimit(semaphore.getLimit() - 1);
          }
        }
      } finally {
        processed++;
        semaphore.release();
      }
    });

    await Promise.all(tasks);
    if (skippedCount > 0) {
      console.log(chalk.gray(`Skipped ${skippedCount} unchanged files from previous session.`));
    }

    const totalTime = Math.round((Date.now() - startTime) / 1000);

    // Generate project files (config, .gitignore, README.md)
    const projectFiles = generateProjectFiles(options.to, projectName, options.from);

    const generatedFiles: string[] = [];

    if (projectFiles.config) {
      await fs.writeFile(`${target}/${projectFiles.config.filename}`, projectFiles.config.content);
      generatedFiles.push(projectFiles.config.filename);
    }

    await fs.writeFile(`${target}/${projectFiles.gitignore.filename}`, projectFiles.gitignore.content);
    generatedFiles.push(projectFiles.gitignore.filename);

    await fs.writeFile(`${target}/${projectFiles.readme.filename}`, projectFiles.readme.content);
    generatedFiles.push(projectFiles.readme.filename);

    console.log(chalk.cyan(`\n📦 Generated: ${generatedFiles.join(', ')}`));

    if (options.to === 'dart') {
      const reportPath = `${target}/morphie-import-report.txt`;
      const markdownPath = `${target}/morphie-import-report.md`;
      const reportText = buildImportReport(importIssues);
      const reportMarkdown = buildImportReportMarkdown(importIssues);
      await fs.writeFile(reportPath, reportText);
      await fs.writeFile(markdownPath, reportMarkdown);
      console.log(chalk.gray(`Import report: ${reportPath}`));
    }

    if (options.to === 'dart') {
      await postProcessDartProject(target, engine, projectName, fs);
    }

    if (options.dartAnalyze && options.to === 'dart') {
      const reportPath = options.dartAnalyzeReport ?? `${target}/morphie-dart-analyze.txt`;
      const markdownPath = options.dartAnalyzeMd ?? `${target}/morphie-dart-analyze.md`;
      const topIssues = parsePositiveInt(options.dartAnalyzeTop, 10);
      const analyzeOk = await runDartAnalyze(
        target,
        reportPath,
        markdownPath,
        fs,
        options.dartAnalyzeFailOnWarnings ?? false,
        topIssues,
        options.verbose
      );
      if (!analyzeOk) {
        process.exitCode = 1;
      }
    }

    session.phase = failCount > 0 ? 'failed' : 'completed';
    await sessionManager.save(sessionPath, session);

    console.log(chalk.green(`\n✅ Porting completed in ${formatTime(totalTime)}!`));
    console.log(`  Success: ${chalk.green(successCount)}`);
    console.log(`  Failed: ${chalk.red(failCount)}`);
    console.log(`  Output: ${chalk.cyan(target)}`);

  } catch (error) {
    spinner.fail('Porting failed');
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    process.exit(1);
  }
}

function buildImportReport(
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

function buildImportReportMarkdown(
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

class AdaptiveSemaphore {
  private limit: number;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  getLimit(): number {
    return this.limit;
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    while (this.waiters.length > 0 && this.active < this.limit) {
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push(() => resolve());
    });
    this.active += 1;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.waiters.length > 0 && this.active < this.limit) {
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    }
  }
}

async function appendEmptyResponse(target: string, file: string, fs: FileSystem): Promise<void> {
  const reportPath = `${target}/morphie-empty-response.txt`;
  const markdownPath = `${target}/morphie-empty-response.md`;
  const line = `- ${file}`;

  let existing = '';
  if (await fs.fileExists(reportPath)) {
    existing = await fs.readFile(reportPath);
  }
  const updated = existing ? `${existing.trim()}\n${line}\n` : `Empty response files:\n${line}\n`;
  await fs.writeFile(reportPath, updated);

  let existingMd = '';
  if (await fs.fileExists(markdownPath)) {
    existingMd = await fs.readFile(markdownPath);
  }
  const updatedMd = existingMd
    ? `${existingMd.trim()}\n${line}\n`
    : `# Empty Response Report\n\n${line}\n`;
  await fs.writeFile(markdownPath, updatedMd);
}

async function postProcessDartProject(
  target: string,
  engine: PortingEngine,
  projectName: string,
  fs: FileSystem
): Promise<void> {
  const libDir = `${target}/lib`;
  if (!(await fs.directoryExists(libDir))) {
    return;
  }

  const files = await fs.listFilesRecursive(libDir);
  const externalPackages = new Set<string>();

  for (const filePath of files) {
    if (!filePath.endsWith('.dart')) {
      continue;
    }
    const content = await fs.readFile(filePath);
    const relativeTargetPath = path.relative(target, filePath).replace(/\\/g, '/');
    const cleaned = engine.finalizeImportsForTarget(content, relativeTargetPath);
    if (cleaned !== content) {
      await fs.writeFile(filePath, cleaned);
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
    const pubspecPath = `${target}/pubspec.yaml`;
    if (await fs.fileExists(pubspecPath)) {
      const content = await fs.readFile(pubspecPath);
      const updated = addDartDependencies(content, Array.from(externalPackages));
      if (updated !== content) {
        await fs.writeFile(pubspecPath, updated);
      }
    }
  }
}
