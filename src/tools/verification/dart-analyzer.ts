/**
 * Dart Analyzer Tool - Runs dart analyze and captures a report
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { BaseTool, type ToolContext, type ToolResult } from '../tool-base.js';
import { FileSystem } from '../../utils/filesystem.js';

const execFileAsync = promisify(execFile);

export interface DartAnalyzeSummary {
  errors: number;
  warnings: number;
  infos: number;
}

export interface DartAnalyzeResult {
  valid: boolean;
  skipped: boolean;
  summary: DartAnalyzeSummary;
  reportPath: string;
  markdownPath: string;
  totalIssues: number;
  issueFiles: string[];
  output: string;
}

export class DartAnalyzer extends BaseTool {
  readonly name = 'dart-analyzer';
  readonly description = 'Runs dart analyze and records a summary report';
  readonly category = 'verification' as const;

  private fs = new FileSystem();

  async execute(context: ToolContext): Promise<ToolResult> {
    try {
      this.validateContext(context, ['targetPath', 'targetLanguage']);

      const targetPath = context.targetPath as string;
      const targetLanguage = context.targetLanguage as string;
      const reportPath = (context.reportPath as string) || `${targetPath}/morphie-dart-analyze.txt`;
      const markdownPath = (context.markdownPath as string) || `${targetPath}/morphie-dart-analyze.md`;
      const failOnWarnings = (context.failOnWarnings as boolean) ?? false;
      const topIssues = (context.topIssues as number) ?? 10;

      if (targetLanguage !== 'dart') {
        return this.createSuccessResult({
          valid: true,
          skipped: true,
          summary: { errors: 0, warnings: 0, infos: 0 },
          reportPath,
          markdownPath,
          totalIssues: 0,
          issueFiles: [],
          output: '',
        } satisfies DartAnalyzeResult);
      }

      const dartAvailable = await this.ensureDartAvailable();
      if (!dartAvailable) {
        return this.createSuccessResult({
          valid: true,
          skipped: true,
          summary: { errors: 0, warnings: 0, infos: 0 },
          reportPath,
          markdownPath,
          totalIssues: 0,
          issueFiles: [],
          output: '',
        } satisfies DartAnalyzeResult);
      }

      const result = await this.runAnalyze(targetPath);
      const summary = this.summarize(result.output);
      await this.fs.writeFile(reportPath, result.output || 'No issues reported.');
      const totalIssues = this.countIssues(result.output);
      const issueFiles = this.extractIssueFiles(result.output);
      const markdown = this.buildMarkdownReport(summary, reportPath, result.output, topIssues);
      await this.fs.writeFile(markdownPath, markdown);

      const valid = summary.errors === 0 && (!failOnWarnings || summary.warnings === 0);

      return this.createSuccessResult({
        valid,
        skipped: false,
        summary,
        reportPath,
        markdownPath,
        totalIssues,
        issueFiles,
        output: result.output,
      } satisfies DartAnalyzeResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.createFailureResult(`Dart analyze failed: ${message}`);
    }
  }

  private async ensureDartAvailable(): Promise<boolean> {
    try {
      await execFileAsync('dart', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  private async runAnalyze(targetPath: string): Promise<{ output: string; success: boolean }> {
    try {
      const result = await execFileAsync('dart', ['analyze'], {
        cwd: targetPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      return { output, success: true };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
      return { output, success: false };
    }
  }

  private summarize(output: string): DartAnalyzeSummary {
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

  private buildMarkdownReport(
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
    const details = limited.length > 0
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
      details,
      lines.length > limited.length ? `\n(Showing top ${limited.length} of ${lines.length} issues)` : '',
      '',
    ].join('\n');
  }

  private countIssues(output: string): number {
    return output.split('\n').filter(line => line.includes(' • ')).length;
  }

  private extractIssueFiles(output: string): string[] {
    const files = new Set<string>();
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.includes(' • ')) {
        continue;
      }
      const match = trimmed.match(/^(.+?):\d+:\d+\s+•\s+(error|warning|info)\b/i);
      if (match && match[1]) {
        files.add(match[1].replace(/\\/g, '/'));
      }
    }

    return Array.from(files);
  }
}
