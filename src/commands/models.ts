import chalk from 'chalk';
import ora from 'ora';
import { createLLMClient, type LLMProvider } from '../llm/factory.js';

interface ModelsOptions {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  ollamaUrl: string;
}

function parseProvider(value: string | undefined): LLMProvider {
  const provider = (value ?? 'lmstudio').toLowerCase();
  if (provider === 'ollama' || provider === 'openai' || provider === 'mlx' || provider === 'lmstudio') {
    return provider;
  }
  throw new Error(`Invalid --provider: ${value}. Use one of: ollama, openai, mlx, lmstudio.`);
}

function getDefaultBaseUrl(provider: LLMProvider, ollamaUrl: string): string {
  if (provider === 'ollama') {
    return ollamaUrl;
  }
  if (provider === 'mlx') {
    return 'http://127.0.0.1:9090/v1';
  }
  if (provider === 'lmstudio') {
    return 'http://127.0.0.1:1234/v1';
  }
  return 'http://127.0.0.1:8000/v1';
}

export async function listModels(options: ModelsOptions): Promise<void> {
  console.log(chalk.blue.bold('\n🍴 Morphie - Available Models\n'));

  const provider = parseProvider(options.provider);
  const baseUrl = options.baseUrl ?? getDefaultBaseUrl(provider, options.ollamaUrl);
  const spinner = ora(`Fetching models from ${provider}...`).start();

  try {
    const client = createLLMClient({
      provider,
      baseUrl,
      model: 'placeholder',
      apiKey: options.apiKey,
    });
    const models = await client.listModels();

    if (models.length === 0) {
      spinner.warn('No models found at the configured endpoint.');
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
    console.log(chalk.yellow(`\nVerify provider/base URL: ${provider} @ ${baseUrl}`));
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
