# Phase 1 Execution Routing Manual Tests

## Purpose

These scenarios were exercised successfully against Phase 1. They verify
explicit `run --orchestrate`, automatic catalog discovery, multimodal specialist
routing, requested-agent synthesis, and compatibility with TypeSafe/JEV primary
agent selection.

The examples use OpenRouter and `google/gemini-2.5-flash`. Substitute a current
provider/model that accepts the relevant modalities when necessary.

## Shared fixtures

```bash
mkdir -p routing-manual/{agents,fixtures}
magick -size 320x200 xc:red routing-manual/fixtures/red.png
ffmpeg -y \
  -f lavfi -i "sine=frequency=440:duration=2" \
  routing-manual/fixtures/tone.wav
```

Export the provider key:

```bash
export OPENROUTER_API_KEY="..."
```

Create `routing-manual/agents/coordinator.json`:

```json
{
  "version": 1,
  "id": "coordinator",
  "name": "Coordinator",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "google/gemini-2.5-flash",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "systemInstructions": "Synthesize specialist findings into one concise answer.",
  "tools": [],
  "capabilities": {
    "modalitiesSupported": ["text"]
  }
}
```

Create `routing-manual/agents/image-specialist.json`:

```json
{
  "version": 1,
  "id": "image-specialist",
  "name": "Image Specialist",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "google/gemini-2.5-flash",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "systemInstructions": "Analyze images precisely and report concise findings.",
  "tools": [],
  "capabilities": {
    "modalitiesSupported": ["text", "image"],
    "modalitiesPreferred": ["image"],
    "modalityRoles": {
      "image": "analyze"
    }
  }
}
```

Create `routing-manual/agents/audio-specialist.json`:

```json
{
  "version": 1,
  "id": "audio-specialist",
  "name": "Audio Specialist",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "google/gemini-2.5-flash",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "systemInstructions": "Analyze audio precisely and report concise findings.",
  "tools": [],
  "capabilities": {
    "modalitiesSupported": ["text", "audio"],
    "modalitiesPreferred": ["audio"],
    "modalityRoles": {
      "audio": "analyze"
    }
  }
}
```

## Scenario 1: fixed requested agent with discovered specialists

Create `routing-manual/agent.settings.json`:

```json
{
  "runtime": { "mode": "memory" },
  "agent": {
    "mode": "fixed",
    "configPath": "./agents/coordinator.json"
  },
  "agents": {
    "dirs": ["./agents"]
  },
  "taskPreparation": {
    "mode": "never"
  }
}
```

Run without `--catalog` so the test exercises discovery from `agents.dirs`:

```bash
adaptive-agent run \
  --cwd ./routing-manual \
  --agent ./agents/coordinator.json \
  --orchestrate \
  --enhance never \
  --image ./fixtures/red.png \
  --audio ./fixtures/tone.wav \
  --events \
  --inspect \
  --output json \
  "Describe the image, analyze the audio, and combine both findings."
```

Expected stages:

```text
image_specialist -> image-specialist
audio_specialist -> audio-specialist
final_synthesis  -> coordinator
```

Expected execution shape is `parallel_fanout_then_synthesis`. The routing
decision assigns text to `coordinator`, image to `image-specialist`, and audio
to `audio-specialist`. It also records a credential-free catalog fingerprint.

## Scenario 2: JEV-selected primary with deterministic specialists

For this scenario, change the coordinator's declared support to:

```json
"capabilities": {
  "modalitiesSupported": ["text", "image", "audio"]
}
```

The underlying coordinator provider/model must actually support those
modalities because runtime/provider checks remain authoritative.

Replace `routing-manual/agent.settings.json` with:

```json
{
  "runtime": { "mode": "memory" },
  "agent": {
    "mode": "auto",
    "configPath": "./agents/coordinator.json"
  },
  "agents": {
    "dirs": ["./agents"]
  },
  "taskPreparation": {
    "mode": "never"
  },
  "agentSelection": {
    "engine": "typesafe",
    "typesafe": {
      "model": "jev-latest",
      "apiKeyEnv": "TYPESAFE_API_KEY",
      "policy": {
        "relevance": {
          "instructions": "Is this profile a strong match for the complete objective and every requested attachment type?",
          "criteria": {
            "true": "The profile can complete the objective and supports every attachment type.",
            "false": "The profile is mismatched or cannot process every attachment type."
          }
        },
        "selection": {
          "instructions": "Which candidate is the best primary profile for completing the full objective?",
          "candidateCriteria": "Prefer the narrowest profile capable of processing every attachment."
        },
        "minimumRelevance": 0.5,
        "minimumConfidence": 0.5
      }
    }
  }
}
```

Export the JEV key and omit `--agent`, allowing auto selection to run:

```bash
export TYPESAFE_API_KEY="..."

adaptive-agent run \
  --cwd ./routing-manual \
  --orchestrate \
  --enhance never \
  --image ./fixtures/red.png \
  --audio ./fixtures/tone.wav \
  --events \
  --output json \
  "Describe the image, analyze the audio, and combine both findings."
```

Expected flow:

```text
JEV selects coordinator as the primary profile
  -> deterministic image assignment to image-specialist
  -> deterministic audio assignment to audio-specialist
  -> coordinator synthesis
```

The request metadata contains the JEV primary selection under
`request.metadata.agentSelection`. The orchestration decision source remains
`deterministic` in Phase 1 because JEV does not propose specialist assignments.

## Important Phase 1 behavior

- Supplying explicit `--agent` bypasses automatic/JEV primary selection.
- Without `--orchestrate`, auto selection still requires one profile that
  supports every supplied modality.
- Explicit `--orchestrate` is a force override. It uses deterministic routing
  even when `agentSelection.engine` is `typesafe`.
- Missing capability metadata means text-only.
- `--catalog` remains additive, but neither scenario needs it because all
  profiles are discovered from configured `agents.dirs`.
