#!/usr/bin/env node

import { Command } from 'commander';
import { portProject } from './commands/port.js';
import { analyzeProject } from './commands/analyze.js';
import { listModels } from './commands/models.js';

const program = new Command();

program
  .name('morphie')
  .description('CLI tool for porting open source projects to different languages using local LLM')
  .version('0.1.0');

program
  .command('port')
  .description('Port a project from one language to another')
  .argument('<source>', 'Source project directory')
  .argument('<target>', 'Target output directory')
  .requiredOption('-f, --from <language>', 'Source language (e.g., python, javascript, go)')
  .requiredOption('-t, --to <language>', 'Target language (e.g., rust, typescript, java)')
  .option('-m, --model <model>', 'LLM model to use (default: qwen3-coder:30b-a3b-q8_0)', 'qwen3-coder:30b-a3b-q8_0')
  .option('--provider <provider>', 'LLM provider: ollama|openai', 'ollama')
  .option('--base-url <url>', 'LLM API base URL (overrides --ollama-url if set)')
  .option('--api-key <key>', 'API key for OpenAI-compatible providers')
  .option('--reviewer-model <model>', 'Reviewer model for failure-retry stage (default: deepseek-r1:70b)')
  .option('--reviewer-provider <provider>', 'Reviewer provider: ollama|openai (defaults to --provider)')
  .option('--reviewer-base-url <url>', 'Reviewer API base URL (defaults to --base-url/--ollama-url)')
  .option('--reviewer-api-key <key>', 'API key for reviewer provider (defaults to --api-key)')
  .option('--ollama-url <url>', 'Ollama API URL', 'http://localhost:11434')
  .option('--dry-run', 'Analyze without actually porting')
  .option('-v, --verbose', 'Verbose output')
  .option('--no-agent', 'Disable agent mode and use legacy pipeline')
  .option('-i, --interactive', 'Interactive mode (requires user approval for plans)')
  .option('--dart-analyze', 'Run dart analyze on the generated project (Dart target only)')
  .option('--dart-analyze-report <file>', 'Write dart analyze output to a report file (defaults to <target>/morphie-dart-analyze.txt)')
  .option('--dart-analyze-md <file>', 'Write dart analyze markdown summary (defaults to <target>/morphie-dart-analyze.md)')
  .option('--dart-analyze-fail-on-warnings', 'Treat dart analyze warnings as errors')
  .option('--dart-analyze-top <count>', 'Limit dart analyze report details to top N issues', '10')
  .option('--dart-analyze-retry-threshold <count>', 'Auto-refine if dart analyze issues >= count', '1')
  .option('--dart-analyze-max-retries <count>', 'Max auto-refine attempts triggered by dart analyze', '1')
  .option('--dart-analyze-error-threshold <count>', 'Auto-refine if dart analyze errors >= count')
  .option('--dart-analyze-warning-threshold <count>', 'Auto-refine if dart analyze warnings >= count')
  .option('--dart-analyze-info-threshold <count>', 'Auto-refine if dart analyze infos >= count')
  .option('--resume', 'Resume from last session in <target>/.morphie/session.json')
  .option('--no-resume', 'Do not auto-resume even if a session exists')
  .option('--refresh-understanding', 'Recompute agent understanding even when resuming')
  .option('--concurrency <count>', 'Number of files to port in parallel', '2')
  .option('--no-auto-concurrency', 'Disable adaptive concurrency')
  .option('--test-mode <mode>', 'How to port test files: skip|only', 'skip')
  .action(portProject);

program
  .command('analyze')
  .description('Analyze a project structure without porting')
  .argument('<source>', 'Source project directory')
  .option('-f, --from <language>', 'Source language (auto-detect if not specified)')
  .option('-v, --verbose', 'Verbose output')
  .action(analyzeProject);

program
  .command('models')
  .description('List available LLM models from provider endpoint')
  .option('--provider <provider>', 'LLM provider: ollama|openai', 'ollama')
  .option('--base-url <url>', 'LLM API base URL (overrides --ollama-url if set)')
  .option('--api-key <key>', 'API key for OpenAI-compatible providers')
  .option('--ollama-url <url>', 'Ollama API URL', 'http://localhost:11434')
  .action(listModels);

program.parse();
