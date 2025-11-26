# Forky

**Fork it, Port it, Done.**

Local LLM을 활용하여 오픈소스 프로젝트를 다른 프로그래밍 언어로 1:1 포팅하는 CLI 도구입니다.

## Features

- 로컬 LLM (Ollama)을 사용한 코드 변환
- 원본 폴더/클래스 구조 보존
- 파일명 컨벤션 자동 변환 (camelCase → snake_case 등)
- 진행률 및 예상 시간 표시
- 다양한 언어 지원

## Supported Languages

| From | To |
|------|-----|
| TypeScript | Dart, Rust, Go, Java, Kotlin, Python |
| JavaScript | Dart, Rust, Go, Java, Kotlin, Python |
| Python | TypeScript, Dart, Rust, Go, Java |
| Go | TypeScript, Dart, Rust, Python, Java |

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai) 실행 중
- 코드 생성용 LLM 모델 (예: `codellama:7b`, `qwen2.5-coder`, `deepseek-coder`)

## Installation

```bash
npm install
npm run build
```

## Usage

### 프로젝트 포팅

```bash
# 기본 사용법
forky port <source-dir> <target-dir> -f <from-lang> -t <to-lang>

# TypeScript → Dart 포팅
forky port ./my-ts-project ./my-dart-project -f typescript -t dart

# 특정 모델 지정
forky port ./src ./output -f typescript -t dart -m codellama:7b

# Dry run (분석만)
forky port ./src ./output -f typescript -t dart --dry-run

# 상세 출력
forky port ./src ./output -f typescript -t dart -v
```

### 프로젝트 분석

```bash
forky analyze <source-dir>

# 파일 목록 포함
forky analyze ./my-project -v
```

### 사용 가능한 모델 확인

```bash
forky models
```

## CLI Options

### `port` command

| Option | Description | Default |
|--------|-------------|---------|
| `-f, --from <lang>` | 소스 언어 | Required |
| `-t, --to <lang>` | 타겟 언어 | Required |
| `-m, --model <model>` | Ollama 모델 | `codellama` |
| `--ollama-url <url>` | Ollama API URL | `http://localhost:11434` |
| `--dry-run` | 포팅 없이 분석만 | `false` |
| `-v, --verbose` | 상세 출력 | `false` |

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
# 개발 모드 실행
npm run dev -- <command>

# 빌드
npm run build

# 린트
npm run lint

# 테스트
npm test
```

## License

MIT
