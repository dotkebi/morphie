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


# 프로젝트 폴더에서
cat > CLAUDE.md << 'EOF'
# Morphie 개발 가이드

## 빌드 & 테스트
- 빌드: `npm run build`
- 테스트: `npm test`
- 린트: `npm run lint`
- 코드 수정 후 반드시 빌드 성공 확인

## 아키텍처 원칙
- 단일 책임 원칙 준수 — 하나의 클래스는 하나의 역할
- any 타입 사용 금지
- 타입은 src/types/agent-types.ts에서 단일 정의, 중복 금지

## 디렉터리 구조
- src/core/ — 오케스트레이션 (AgentOrchestrator, ProjectAnalyzer)
- src/porting/ — 변환 로직 (PortingEngine, PromptBuilder, ImportResolver, DartPostProcessor, DartValidator)
- src/types/ — 공유 타입 정의
- src/llm/ — LLM 클라이언트
- src/utils/ — 유틸리티
EOF
