import chalk from 'chalk';
import ora from 'ora';
import { OllamaClient } from '../llm/ollama.js';

interface ModelsOptions {
  ollamaUrl: string;
}

export async function listModels(options: ModelsOptions): Promise<void> {
  console.log(chalk.blue.bold('\n🍴 Forky - Available Models\n'));

  const spinner = ora('Fetching models from Ollama...').start();

  try {
    const client = new OllamaClient(options.ollamaUrl);
    const models = await client.listModels();

    if (models.length === 0) {
      spinner.warn('No models found. Pull a model with: ollama pull codellama');
      return;
    }

    spinner.succeed(`Found ${models.length} model(s):\n`);

    for (const model of models) {
      console.log(`  ${chalk.green('•')} ${chalk.bold(model.name)}`);
      if (model.size) {
        console.log(`    Size: ${chalk.gray(formatBytes(model.size))}`);
      }
      if (model.modifiedAt) {
        console.log(`    Modified: ${chalk.gray(model.modifiedAt)}`);
      }
    }

    console.log(chalk.gray('\nRecommended models for code porting:'));
    console.log(chalk.gray('  • codellama - General code generation'));
    console.log(chalk.gray('  • deepseek-coder - Code understanding'));
    console.log(chalk.gray('  • qwen2.5-coder - Multi-language support'));

  } catch (error) {
    spinner.fail('Failed to fetch models');
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    console.log(chalk.yellow('\nMake sure Ollama is running: ollama serve'));
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
