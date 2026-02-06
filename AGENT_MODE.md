# Morphie Agent System - Quick Start

## 🤖 Agent Mode

Morphie now includes an **agentic mode** that uses reasoning, planning, and self-correction for intelligent code porting.

### Basic Usage

```bash
# Enable agent mode
morphie port ./source ./target --from typescript --to dart --agent

# Interactive mode (requires plan approval)
morphie port ./source ./target --from typescript --to dart --agent --interactive

# Verbose mode (see reasoning traces)
morphie port ./source ./target --from typescript --to dart --agent --verbose
```

### How It Works

The agent follows a **Think → Plan → Act → Observe → Reflect** loop:

1. **Think**: Analyzes your project and determines the best strategy
2. **Plan**: Creates a detailed execution plan with phases
3. **Act**: Executes the plan using specialized tools
4. **Observe**: Checks quality and identifies issues
5. **Reflect**: Learns from results and refines if needed

### Example Output

```
🤖 Running with Agent Orchestrator...

🤔 THINK: Analyzing task...
   Project type: library
   Complexity: medium
   Strategy: File-by-file porting with dependency ordering

📋 PLAN: Creating execution plan...
   Phases: 3
   Total tasks: 15
   Estimated duration: 8m

🚀 ACT: Executing plan...

📦 Phase 1: Analysis
   ✓ Phase complete (15 files, 2341ms)

📦 Phase 2: Porting: Core
   ✓ Phase complete (8 files, 12453ms)

📦 Phase 3: Verification
   ✓ Phase complete (8 files, 1234ms)

👀 OBSERVE: Analyzing results...
   Quality score: 94/100
   Syntax errors: 0
   Quality issues: 2

💭 REFLECT: Evaluating outcomes...
   Acceptable: Yes
   Learnings captured: 3

✅ Agent completed successfully!
  Total files: 15
  Success: 15
  Failed: 0
  Duration: 2m 18s
  Quality score: 94/100
```

### Agent vs Standard Mode

| Feature | Standard Mode | Agent Mode |
|---------|--------------|------------|
| Execution | Single-pass | Multi-pass with refinement |
| Planning | None | Detailed task decomposition |
| Quality Checks | None | Syntax + quality verification |
| Error Recovery | Fail on error | Retry with recovery |
| Learning | None | Learns patterns |
| Interaction | Batch only | Optional interactive mode |

### Architecture

The agent system includes:

- **Agent Orchestrator**: Main reasoning loop
- **Tool System**: Modular capabilities (analysis, porting, verification, refinement)
- **Planning System**: Task decomposition and execution planning
- **Conversation Manager**: Context tracking and learning
- **Type System**: Comprehensive TypeScript types

For more details, see the [walkthrough](file:///Users/mj/.gemini/antigravity/brain/5a13b9e5-dcf3-4e55-a8d2-7d306a57bfa8/walkthrough.md).
