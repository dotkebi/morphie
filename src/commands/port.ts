import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProjectAnalyzer } from '../core/analyzer.js';
import { PortingEngine } from '../core/porting-engine.js';
import { AgentOrchestrator } from '../core/agent-orchestrator.js';
import { OllamaClient } from '../llm/ollama.js';
import { FileSystem } from '../utils/filesystem.js';
import { addDartDependencies, generateProjectFiles } from '../utils/project-config.js';
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
}

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
    const sessionManager = new SessionManager();
    const sessionPath = `${target}/.morphie/session.json`;
    const existingSession = options.resume ? await sessionManager.load(sessionPath) : null;
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
    spinner.text = 'Connecting to Ollama...';
    const llm = new OllamaClient(options.ollamaUrl, options.model);
    const isConnected = await llm.healthCheck();
    if (!isConnected) {
      spinner.fail('Cannot connect to Ollama. Make sure Ollama is running.');
      process.exit(1);
    }

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
        resume: options.resume,
        sessionPath,
        refreshUnderstanding: options.refreshUnderstanding,
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

    spinner.stop();

    const totalFiles = analysis.files.length;
    console.log(chalk.cyan(`\nPorting ${totalFiles} files:\n`));

    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();
    const importIssues: Array<{ file: string; issues: string[]; required: string[]; actual: string[] }> = [];
    const completed = new Set(existingSession?.completedFiles ?? []);

    for (let i = 0; i < analysis.files.length; i++) {
      const file = analysis.files[i];
      if (completed.has(file.relativePath)) {
        continue;
      }
      const progress = `[${i + 1}/${totalFiles}]`;
      const percent = Math.round(((i + 1) / totalFiles) * 100);
      const fileSpinner = ora(`${progress} ${percent}% Porting ${file.relativePath}...`).start();

      try {
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
        session.completedFiles = Array.from(completed);
        session.phase = 'porting';
        await sessionManager.save(sessionPath, session);
        fileSpinner.succeed(`${progress} ${file.relativePath} → ${result.targetPath}`);
        successCount++;
      } catch (error) {
        fileSpinner.fail(`${progress} Failed: ${file.relativePath}`);
        if (options.verbose && error instanceof Error) {
          console.log(chalk.red(`  Error: ${error.message}`));
        }
        failCount++;
        session.failedFiles.push({
          file: file.relativePath,
          error: error instanceof Error ? error.message : String(error),
        });
        session.phase = 'porting';
        await sessionManager.save(sessionPath, session);
      }

      // Show ETA every 10 files
      if ((i + 1) % 10 === 0 && i + 1 < totalFiles) {
        const elapsed = (Date.now() - startTime) / 1000;
        const avgTime = elapsed / (i + 1);
        const remaining = Math.round(avgTime * (totalFiles - i - 1));
        console.log(chalk.gray(`  ⏱  ETA: ${formatTime(remaining)}`));
      }
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
