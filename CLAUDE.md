# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Morphie is a CLI tool that ports open source projects from one programming language to another using local LLM (via Ollama). It performs 1:1 code translation while preserving functionality, structure, and idioms.

## Commands

```bash
# Install dependencies
npm install

# Development (run without building)
npm run dev -- <command>

# Build
npm run build

# Run built CLI
npm start -- <command>
# or after global install: morphie <command>

# Lint
npm run lint
npm run lint:fix

# Test
npm test              # run all tests
npm run test:watch    # watch mode
npx vitest run src/path/to/file.test.ts  # single test file
```

## CLI Usage

```bash
# Port a project
morphie port <source-dir> <target-dir> -f <source-lang> -t <target-lang> [-m model]

# Analyze a project without porting
morphie analyze <source-dir> [-f language]

# List available Ollama models
morphie models [--ollama-url <url>]
```

## Architecture

```
src/
├── cli.ts              # CLI entry point (commander setup)
├── index.ts            # Library exports
├── commands/           # CLI command handlers
│   ├── port.ts         # Main porting workflow
│   ├── analyze.ts      # Project analysis only
│   └── models.ts       # List Ollama models
├── core/
│   ├── analyzer.ts     # ProjectAnalyzer: scans source project, detects language, collects files
│   └── porting-engine.ts # PortingEngine: builds prompts, calls LLM, extracts ported code
├── llm/
│   └── ollama.ts       # OllamaClient: HTTP client for Ollama API (generate, list models)
└── utils/
    ├── filesystem.ts   # File I/O utilities
    └── languages.ts    # Language detection, extensions, features mapping
```

## Key Patterns

- **Porting flow**: `ProjectAnalyzer.analyze()` → iterate files → `PortingEngine.portFile()` → write output
- **LLM integration**: Uses Ollama REST API at `/api/generate` and `/api/tags`
- **Language support**: Defined in `utils/languages.ts` - add new languages there
- **Prompts**: Built in `PortingEngine.buildPortingPrompt()` with language-specific context
