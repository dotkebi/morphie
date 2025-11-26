# Forky

**Fork it, Port it, Done.**

A CLI tool that ports open source projects to different programming languages using local LLM.

## Features

- Code conversion using local LLM (Ollama)
- Preserves original folder/class structure
- Automatic file naming convention conversion (e.g., camelCase → snake_case)
- Progress tracking with ETA
- Multi-language support

## Supported Languages

| From | To |
|------|-----|
| TypeScript | Dart, Rust, Go, Java, Kotlin, Python |
| JavaScript | Dart, Rust, Go, Java, Kotlin, Python |
| Python | TypeScript, Dart, Rust, Go, Java |
| Go | TypeScript, Dart, Rust, Python, Java |

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai) running locally
- Code generation LLM model (e.g., `codellama:7b`, `qwen2.5-coder`, `deepseek-coder`)

## Installation

```bash
npm install
npm run build
```

## Usage

### Port a project

```bash
# Basic usage
forky port <source-dir> <target-dir> -f <from-lang> -t <to-lang>

# TypeScript → Dart
forky port ./my-ts-project ./my-dart-project -f typescript -t dart

# With specific model
forky port ./src ./output -f typescript -t dart -m codellama:7b

# Dry run (analyze only)
forky port ./src ./output -f typescript -t dart --dry-run

# Verbose output
forky port ./src ./output -f typescript -t dart -v
```

### Analyze a project

```bash
forky analyze <source-dir>

# With file listing
forky analyze ./my-project -v
```

### List available models

```bash
forky models
```

## CLI Options

### `port` command

| Option | Description | Default |
|--------|-------------|---------|
| `-f, --from <lang>` | Source language | Required |
| `-t, --to <lang>` | Target language | Required |
| `-m, --model <model>` | Ollama model | `codellama` |
| `--ollama-url <url>` | Ollama API URL | `http://localhost:11434` |
| `--dry-run` | Analyze without porting | `false` |
| `-v, --verbose` | Verbose output | `false` |

## Example

```
🍴 Forky - Project Porting Tool

Porting 209 files:

✔ [1/209] index.ts → index.dart
✔ [2/209] Util/index.ts → util/index.dart
✔ [3/209] Util/PSMath.ts → util/psmath.dart
  ⏱  ETA: 55m 37s
...

✅ Porting completed in 1h 23m!
  Success: 205
  Failed: 4
  Output: ./output
```

## Development

```bash
# Run in development mode
npm run dev -- <command>

# Build
npm run build

# Lint
npm run lint

# Test
npm test
```

## License

MIT
