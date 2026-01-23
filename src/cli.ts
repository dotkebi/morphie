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
  .option('-m, --model <model>', 'LLM model to use (default: codellama:7b)', 'codellama:7b')
  .option('--ollama-url <url>', 'Ollama API URL', 'http://localhost:11434')
  .option('--dry-run', 'Analyze without actually porting')
  .option('-v, --verbose', 'Verbose output')
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
  .description('List available LLM models from Ollama')
  .option('--ollama-url <url>', 'Ollama API URL', 'http://localhost:11434')
  .action(listModels);

program.parse();
