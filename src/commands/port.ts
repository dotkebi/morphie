import chalk from 'chalk';
import ora from 'ora';
import { ProjectAnalyzer } from '../core/analyzer.js';
import { PortingEngine } from '../core/porting-engine.js';
import { OllamaClient } from '../llm/ollama.js';
import { FileSystem } from '../utils/filesystem.js';

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
}

export async function portProject(
  source: string,
  target: string,
  options: PortOptions
): Promise<void> {
  console.log(chalk.blue.bold('\n🍴 Forky - Project Porting Tool\n'));

  const spinner = ora('Initializing...').start();

  try {
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

    // Analyze source project
    spinner.text = 'Analyzing source project...';
    const analyzer = new ProjectAnalyzer(source, options.from);
    const analysis = await analyzer.analyze();

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

    // Port the project
    spinner.text = 'Porting project...';
    const engine = new PortingEngine(llm, options.from, options.to, options.verbose);

    spinner.stop();

    const totalFiles = analysis.files.length;
    console.log(chalk.cyan(`\nPorting ${totalFiles} files:\n`));

    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < analysis.files.length; i++) {
      const file = analysis.files[i];
      const progress = `[${i + 1}/${totalFiles}]`;
      const percent = Math.round(((i + 1) / totalFiles) * 100);
      const fileSpinner = ora(`${progress} ${percent}% Porting ${file.relativePath}...`).start();

      try {
        const result = await engine.portFile(file);
        await fs.writeFile(
          `${target}/${result.targetPath}`,
          result.content
        );
        fileSpinner.succeed(`${progress} ${file.relativePath} → ${result.targetPath}`);
        successCount++;
      } catch (error) {
        fileSpinner.fail(`${progress} Failed: ${file.relativePath}`);
        if (options.verbose && error instanceof Error) {
          console.log(chalk.red(`  Error: ${error.message}`));
        }
        failCount++;
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
