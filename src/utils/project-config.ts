export interface ProjectConfigFile {
  filename: string;
  content: string;
}

export interface ProjectFiles {
  config: ProjectConfigFile | null;
  gitignore: ProjectConfigFile;
  readme: ProjectConfigFile;
}

export function generateProjectFiles(
  targetLanguage: string,
  projectName: string,
  sourceLanguage: string
): ProjectFiles {
  return {
    config: generateProjectConfig(targetLanguage, projectName),
    gitignore: generateGitignore(targetLanguage),
    readme: generateReadme(projectName, sourceLanguage, targetLanguage),
  };
}

export function generateProjectConfig(
  targetLanguage: string,
  projectName: string
): ProjectConfigFile | null {
  const generators: Record<string, () => ProjectConfigFile> = {
    dart: () => generateDartPubspec(projectName),
    python: () => generatePythonPyproject(projectName),
    go: () => generateGoMod(projectName),
    rust: () => generateCargoToml(projectName),
  };

  const generator = generators[targetLanguage];
  return generator ? generator() : null;
}

export function addDartDependencies(pubspecContent: string, dependencies: string[]): string {
  if (dependencies.length === 0) {
    return pubspecContent;
  }

  const uniqueDeps = Array.from(new Set(dependencies)).sort();
  const lines = pubspecContent.split('\n');
  const depIndex = lines.findIndex(line => line.trim() === 'dependencies:');

  if (depIndex === -1) {
    return pubspecContent;
  }

  const existing = new Set<string>();
  for (let i = depIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || !line.startsWith('  ')) {
      break;
    }
    const nameMatch = line.trim().split(':')[0];
    if (nameMatch) {
      existing.add(nameMatch);
    }
  }

  const additions = uniqueDeps.filter(dep => !existing.has(dep));
  if (additions.length === 0) {
    return pubspecContent;
  }

  const insertion = additions.map(dep => `  ${dep}: any`);
  lines.splice(depIndex + 1, 0, ...insertion);

  return lines.join('\n');
}

function generateGitignore(targetLanguage: string): ProjectConfigFile {
  const ignorePatterns: Record<string, string> = {
    dart: `# Dart/Flutter
.dart_tool/
.packages
build/
.pub-cache/
.pub/
*.lock
pubspec.lock

# IDE
.idea/
*.iml
.vscode/

# OS
.DS_Store
Thumbs.db
`,
    python: `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg

# Virtual environments
.env
.venv
env/
venv/
ENV/

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
`,
    go: `# Go
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
go.work
vendor/

# IDE
.idea/
.vscode/

# OS
.DS_Store
Thumbs.db
`,
    rust: `# Rust
/target/
Cargo.lock
**/*.rs.bk

# IDE
.idea/
.vscode/

# OS
.DS_Store
Thumbs.db
`,
  };

  const content = ignorePatterns[targetLanguage] || `# Generated project
build/
dist/
.idea/
.vscode/
.DS_Store
Thumbs.db
`;

  return { filename: '.gitignore', content };
}

function generateReadme(
  projectName: string,
  sourceLanguage: string,
  targetLanguage: string
): ProjectConfigFile {
  const langCommands: Record<string, string> = {
    dart: `## Getting Started

\`\`\`bash
# Install dependencies
dart pub get

# Run tests
dart test

# Analyze code
dart analyze
\`\`\``,
    python: `## Getting Started

\`\`\`bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate

# Install dependencies
pip install -e .

# Run tests
pytest
\`\`\``,
    go: `## Getting Started

\`\`\`bash
# Download dependencies
go mod download

# Run tests
go test ./...

# Build
go build
\`\`\``,
    rust: `## Getting Started

\`\`\`bash
# Build
cargo build

# Run tests
cargo test

# Run
cargo run
\`\`\``,
  };

  const commands = langCommands[targetLanguage] || `## Getting Started

See the documentation for your target language.`;

  const content = `# ${projectName}

This project was automatically ported from ${sourceLanguage} to ${targetLanguage} using [Morphie](https://github.com/anthropics/morphie).

${commands}

## Project Structure

The code structure mirrors the original ${sourceLanguage} project.

## Notes

- This is an automated port and may require manual adjustments
- Please review and test thoroughly before use in production
- Some language-specific idioms may need refinement

## License

Please refer to the original project's license.
`;

  return { filename: 'README.md', content };
}

function generateDartPubspec(projectName: string): ProjectConfigFile {
  const snakeCaseName = projectName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]/g, '_')
    .toLowerCase();

  const content = `name: ${snakeCaseName}
description: A project ported by Morphie
version: 1.0.0

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:

dev_dependencies:
  lints: ^3.0.0
  test: ^1.24.0
`;

  return { filename: 'pubspec.yaml', content };
}

function generatePythonPyproject(projectName: string): ProjectConfigFile {
  const snakeCaseName = projectName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]/g, '_')
    .toLowerCase();

  const content = `[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "${snakeCaseName}"
version = "1.0.0"
description = "A project ported by Morphie"
requires-python = ">=3.8"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=7.0.0"]
`;

  return { filename: 'pyproject.toml', content };
}

function generateGoMod(projectName: string): ProjectConfigFile {
  const content = `module ${projectName}

go 1.21
`;

  return { filename: 'go.mod', content };
}

function generateCargoToml(projectName: string): ProjectConfigFile {
  const snakeCaseName = projectName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]/g, '_')
    .toLowerCase();

  const content = `[package]
name = "${snakeCaseName}"
version = "1.0.0"
edition = "2021"
description = "A project ported by Morphie"

[dependencies]

[dev-dependencies]
`;

  return { filename: 'Cargo.toml', content };
}
