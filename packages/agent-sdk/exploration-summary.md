# Adaptive Agent Exploration Summary

## Overview
This document summarizes the exploration of the agent-sdk directory structure, focusing on finding agent configurations, test files, and understanding how to run the adaptive-agent for evaluation.

## Directory Structure

### Main Directory: `/Users/ugmurthy/riding-amp/AgentSmith/packages/agent-sdk`

```
agent-sdk/
├── dist/                    # Compiled JavaScript files
│   ├── adaptive-agent.js
│   ├── adaptive-agent-tui.js
│   ├── evaluate-gaia-jsonl.js
│   └── index.js
├── specs/                   # Test specifications and fixtures
│   ├── eye.jpeg            # Image file for testing (NOT eye.jpg)
│   ├── lips.jpg            # Another image file
│   ├── image-test.json     # Spec referencing eye.jpeg
│   ├── sketch.json         # Sketch review spec
│   ├── audio-agent.json    # Audio agent configuration
│   ├── agent.settings.json # Agent settings
│   ├── all-types.json      # Multimodal test spec
│   ├── fixtures/           # Test fixtures directory
│   │   ├── sample-image.png
│   │   ├── sample-note.txt
│   │   ├── sample-brief.md
│   │   ├── sample-data.json
│   │   ├── sample-doc.pdf
│   │   └── sample-audio.wav
│   └── logs/               # Log files
├── src/                     # Source TypeScript files
│   ├── adaptive-agent.ts       # Main CLI implementation
│   ├── adaptive-agent-tui.ts   # TUI implementation
│   ├── orchestration.ts        # Orchestration SDK
│   ├── index.ts                # SDK exports
│   └── evaluate-gaia-jsonl.ts  # GAIA benchmark evaluator
├── scripts/                 # Build scripts
├── package.json             # Project configuration
├── tsconfig.json            # TypeScript config
└── ORCHESTRATION-SDK-SKETCH.md # Documentation
```

## Key Files Found

### 1. Eye Image File
- **Location**: `specs/eye.jpeg` (Note: extension is `.jpeg`, not `.jpg`)
- **Referenced by**: `specs/image-test.json`
- **Usage**: Used in image processing tests for sketch review

### 2. Image Test Spec
- **Location**: `specs/image-test.json`
- **Content**: 
```json
{
  "mode": "run",
  "goal": "Review the attached sketch and give me pointers for improvements",
  "input": {
    "ticketId": "Sketch assignment-001"
  },
  "contentParts": [
    {
      "type": "text",
      "text": "Where possible provide a how to do it summary for improvements as this will help execution"
    },
    {
      "type": "image",
      "image": {
        "path": "./eye.jpeg",
        "mimeType": "image/jpeg",
        "detail": "high",
        "name": "Eye"
      }
    }
  ]
}
```

### 3. Sketch Spec
- **Location**: `specs/sketch.json`
- **Content**: Similar to image-test.json but without the image attachment

### 4. Audio Agent Configuration
- **Location**: `specs/audio-agent.json`
- **Purpose**: Agent configuration for audio modality support
- **Key features**:
  - Supports text and audio modalities
  - Uses OpenRouter provider with gpt-audio-mini model
  - Configured for single-step execution with auto-approval

## How to Run Adaptive-Agent for Evaluation

### Installation & Setup

1. **Build the project**:
```bash
cd /Users/ugmurthy/riding-amp/AgentSmith/packages/agent-sdk
bun run build
```

2. **Set up environment variables**:
- `OPENROUTER_API_KEY` - For OpenRouter model provider
- `DATABASE_URL` - For Postgres runtime (optional, defaults to memory mode)

### Running Commands

#### 1. Using the CLI directly

**Run a goal**:
```bash
bun run ./dist/adaptive-agent.js run "Your goal here"
```

**Run with a spec file**:
```bash
bun run ./dist/adaptive-agent.js --spec ./specs/image-test.json
```

**Chat mode**:
```bash
bun run ./dist/adaptive-agent.js chat "Your message"
```

**View configuration**:
```bash
bun run ./dist/adaptive-agent.js config
```

#### 2. Using npm scripts

```bash
# Run adaptive agent
bun run adaptive-agent --spec ./specs/image-test.json

# Run TUI
bun run adaptive-agent:tui
```

#### 3. Running Evaluations

**Generic benchmark cases**:
```bash
bun run ./dist/adaptive-agent.js eval cases \
  --input ./path/to/benchmark.jsonl \
  --out ./path/to/results.jsonl
```

**GAIA benchmark**:
```bash
bun run ./dist/adaptive-agent.js eval gaia \
  --input ./path/to/gaia-data.jsonl \
  --files-dir ./path/to/gaia-files \
  --out ./path/to/gaia-results.jsonl
```

**With additional options**:
```bash
bun run ./dist/adaptive-agent.js eval cases \
  --input ./specs/general-bm.jsonl \
  --out ./results.jsonl \
  --resume \
  --limit 10 \
  --fail-fast
```

### CLI Options Reference

| Option | Description |
|--------|-------------|
| `--spec <path>` | Path to JSON spec file |
| `--file <path>` | Read prompt from file |
| `--input-json <json>` | JSON input for run requests |
| `--image <path>` | Add image attachment (repeatable) |
| `--audio <path>` | Add audio attachment (repeatable) |
| `--file-attachment <path>` | Add file attachment (repeatable) |
| `--mode <chat\|run>` | Override spec mode |
| `--cwd <path>` | Working directory for config lookup |
| `--agent <path>` | Explicit agent.json path |
| `--settings <path>` | Explicit agent.settings.json path |
| `--runtime <mode>` | Runtime mode: memory or postgres |
| `--provider <name>` | Model provider: openrouter, ollama, mistral, mesh |
| `--model <name>` | Model name override |
| `--approval <mode>` | Approval mode: auto, manual, reject |
| `--clarification <mode>` | Clarification mode: interactive or fail |
| `--orchestrate` | Route through orchestration SDK |
| `--catalog <path>` | Agent catalog path (repeatable) |
| `--progress` | Print progress updates |
| `--events` | Print lifecycle events |
| `--inspect` | Print inspection summary |
| `--dry-run` | Resolve without executing |
| `--output <format>` | Output format: pretty, json, jsonl |

### Eval-Specific Options

| Option | Description |
|--------|-------------|
| `--input <path>` | Benchmark input JSONL |
| `--files-dir <path>` | Directory for attachments |
| `--out <path>` | Results output path |
| `--artifacts <dir>` | Artifact directory |
| `--resume` | Skip completed cases |
| `--fail-fast` | Stop after first failure |
| `--limit <n>` | Limit number of cases |
| `--offset <n>` | Skip initial cases |
| `--ids <id,id,...>` | Run specific case IDs |
| `--level <value>` | Filter by level |
| `--split <value>` | Filter by split |

## Agent Configuration

### Agent Config File (`agent.json`)

Required fields:
- `id`: Unique agent identifier
- `name`: Human-readable name
- `invocationModes`: Array of ['run', 'chat']
- `defaultInvocationMode`: Default mode ('run' or 'chat')
- `model`: Provider and model configuration
- `tools`: Array of tool names

Optional fields:
- `capabilities`: Modality support configuration
  - `modalitiesSupported`: ['text', 'image', 'file', 'audio']
  - `modalitiesPreferred`: Preferred modalities
  - `modalityRoles`: Role per modality (ingest, analyze, summarize, synthesize)
- `systemInstructions`: System prompt
- `delegates`: Array of delegate names
- `defaults`: Execution defaults

### Settings File (`agent.settings.json`)

Common settings:
```json
{
  "logging": {
    "enabled": true,
    "level": "info",
    "destination": "file",
    "filePath": "./logs/adaptive-agent.log",
    "pretty": true
  },
  "runtime": {
    "mode": "memory",
    "autoMigrate": true
  },
  "interaction": {
    "approvalMode": "auto",
    "clarificationMode": "interactive"
  }
}
```

## Orchestration Features

The SDK supports multi-agent orchestration with capability-based routing:

1. **Single agent execution**: When requested agent supports all modalities
2. **Sequential specialist + synthesis**: For one unsupported modality
3. **Parallel fanout + synthesis**: For multiple unsupported modalities

### Running with Orchestration

```bash
bun run ./dist/adaptive-agent-tui.js \
  --agent ./path/to/general-agent.json \
  --orchestrate \
  --catalog ./path/to/audio-agent.json \
  --catalog ./path/to/image-agent.json
```

## Notes on sketch-mentor.json

**Important**: No file named `sketch-mentor.json` was found in the directory structure. 

However, there are related files:
- `specs/sketch.json` - A spec file for sketch review tasks
- `specs/image-test.json` - A spec file that uses the eye.jpeg image for sketch review

If you're looking for an agent configuration for sketch mentoring, you may need to:
1. Create a new agent configuration file (e.g., `sketch-mentor.json`)
2. Use existing agent configurations like `audio-agent.json` as a template
3. Configure it with appropriate tools and capabilities for image analysis

## Testing the Eye Image

To test with the eye.jpeg image:

```bash
# Using the spec file
bun run ./dist/adaptive-agent.js --spec ./specs/image-test.json

# Or directly with image flag
bun run ./dist/adaptive-agent.js run "Analyze this image" \
  --image ./specs/eye.jpeg
```

## Summary

- **Eye image location**: `specs/eye.jpeg` (not .jpg)
- **No sketch-mentor.json found**: Only sketch-related spec files exist
- **Evaluation commands**: Use `adaptive-agent eval cases` or `adaptive-agent eval gaia`
- **Main entry points**: `dist/adaptive-agent.js` for CLI, `dist/adaptive-agent-tui.js` for TUI
- **Configuration**: Look for `agent.json` and `agent.settings.json` in workspace or home directory
