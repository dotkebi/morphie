import chalk from 'chalk';
import ora from 'ora';
import { ProjectAnalyzer } from '../core/analyzer.js';
import { FileSystem } from '../utils/filesystem.js';

interface AnalyzeOptions {
  from?: string;
  verbose?: boolean;
}

export async function analyzeProject(
  source: string,
  options: AnalyzeOptions
): Promise<void> {
  console.log(chalk.blue.bold('\n🍴 Forky - Project Analysis\n'));

  const spinner = ora('Analyzing project...').start();

  try {
    const fs = new FileSystem();
    if (!(await fs.directoryExists(source))) {
      spinner.fail('Source directory does not exist');
      process.exit(1);
    }

    const analyzer = new ProjectAnalyzer(source, options.from);
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis completed!\n');

    console.log(chalk.cyan('Project Overview:'));
    console.log(`  Path: ${chalk.gray(source)}`);
    console.log(`  Detected Language: ${chalk.yellow(analysis.language)}`);
    console.log(`  Total Files: ${chalk.yellow(analysis.files.length)}`);

    if (analysis.entryPoints.length > 0) {
      console.log(`\n${chalk.cyan('Entry Points:')}`);
      for (const entry of analysis.entryPoints) {
        console.log(`  • ${chalk.green(entry)}`);
      }
    }

    if (analysis.dependencies.length > 0) {
      console.log(`\n${chalk.cyan('Dependencies:')}`);
      for (const dep of analysis.dependencies) {
        console.log(`  • ${dep}`);
      }
    }

    if (options.verbose) {
      console.log(`\n${chalk.cyan('Files:')}`);
      for (const file of analysis.files) {
        console.log(`  • ${file.relativePath} (${file.type})`);
      }
    }

    console.log(`\n${chalk.cyan('File Types:')}`);
    const typeCounts = analysis.files.reduce((acc, file) => {
      acc[file.type] = (acc[file.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    for (const [type, count] of Object.entries(typeCounts)) {
      console.log(`  • ${type}: ${chalk.yellow(count)}`);
    }

  } catch (error) {
    spinner.fail('Analysis failed');
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    process.exit(1);
  }
}
