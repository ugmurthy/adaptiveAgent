# Phase 2 Adaptive Execution Routing Manual Tests

## Purpose

These examples verify Phase 2's opt-in automatic choice between direct
execution and specialist orchestration. Neither command passes `--agent`,
`--catalog`, or `--orchestrate`; the execution shape comes from
`executionRouting.mode: "adaptive"` and the configured TypeSafe/JEV selection
engine.

The tests make paid TypeSafe/JEV and model-provider calls. They are manual only
and are not part of the automated test suite.

## Prerequisites

Use the image, audio, `coordinator`, `image-specialist`, and `audio-specialist`
fixtures from `PHASE-1-MANUAL-TESTS.md`. In particular, keep the coordinator
text-only for Scenario 1:

```json
"capabilities": {
  "modalitiesSupported": ["text"]
}
```

Export both service credentials:

```bash
export OPENROUTER_API_KEY="..."
export TYPESAFE_API_KEY="..."
```

The examples assume this layout:

```text
routing-manual/
  agents/
    coordinator.json
    image-specialist.json
    audio-specialist.json
  fixtures/
    red.png
    tone.wav
```

## Scenario 1: automatically choose specialist orchestration

Create `routing-manual/agent.settings.json`:

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
  "executionRouting": {
    "mode": "adaptive",
    "maxSpecialists": 2,
    "lowConfidenceFallback": "error"
  },
  "agentSelection": {
    "engine": "typesafe",
    "typesafe": {
      "model": "jev-latest",
      "apiKeyEnv": "TYPESAFE_API_KEY",
      "policy": {
        "relevance": {
          "instructions": "Is this profile a strong match for the objective and this specific attachment modality?",
          "criteria": {
            "true": "The profile is capable and well suited to this modality and objective.",
            "false": "The profile lacks capability or is a weak match for this modality and objective."
          }
        },
        "selection": {
          "candidateCriteria": "Prefer the narrowest capable specialist for each modality."
        },
        "routing": {
          "modeInstructions": "Choose direct only when one profile should process every attachment; otherwise choose orchestration.",
          "primaryInstructions": "Choose the coordinator best suited to synthesize all findings.",
          "assignmentInstructions": "Choose the strongest capable specialist for this modality."
        },
        "minimumRelevance": 0.3,
        "minimumConfidence": 0.4
      }
    }
  }
}
```

Run without the Phase 1 `--orchestrate` force override:

```bash
adaptive-agent run \
  --cwd ./routing-manual \
  --enhance never \
  --image ./fixtures/red.png \
  --audio ./fixtures/tone.wav \
  --events \
  --inspect \
  --output json \
  "Describe the image, identify the audio tone, and synthesize both findings." \
  > routing-manual/phase-2-orchestration.json
```

Inspect the routing result:

```bash
jq '{
  decision: .request.metadata.executionRouting,
  shape: .orchestration.executionShape,
  fingerprint: .orchestration.catalogFingerprint,
  stages: [.orchestration.stages[] | {stage, agentId, status}]
}' routing-manual/phase-2-orchestration.json
```

Expected invariants:

- `decision.mode` is `"orchestration"` and `decision.source` is `"typesafe"`.
- The assignments cover `text`, `image`, and `audio` exactly once.
- `image` is assigned only to a profile declaring image support.
- `audio` is assigned only to a profile declaring audio support.
- The execution has specialist stage(s) followed by synthesis; with the
  supplied profiles and policy, the expected shape is
  `parallel_fanout_then_synthesis` with `image-specialist`,
  `audio-specialist`, and `coordinator` synthesis.
- The output includes a non-empty catalog fingerprint and no attachment paths,
  credentials, model configuration, or profile instructions in the routing
  decision.

JEV confidence can vary. If it falls below the configured thresholds, failure
is the expected safe behavior because `lowConfidenceFallback` is `"error"`.

## Scenario 2: automatically choose one direct multimodal profile

Use a separate catalog so only one profile is eligible. Create
`routing-manual/direct-agents/multimodal.json`:

```json
{
  "version": 1,
  "id": "multimodal",
  "name": "Multimodal Analyst",
  "description": "Analyzes image and audio together and returns one combined answer.",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "google/gemini-2.5-flash",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "systemInstructions": "Analyze every supplied modality and answer concisely.",
  "tools": [],
  "capabilities": {
    "modalitiesSupported": ["text", "image", "audio"],
    "modalitiesPreferred": ["image", "audio"],
    "modalityRoles": {
      "image": "analyze",
      "audio": "analyze",
      "text": "synthesize"
    }
  }
}
```

Replace `routing-manual/agent.settings.json` with:

```json
{
  "runtime": { "mode": "memory" },
  "agent": {
    "mode": "auto",
    "configPath": "./direct-agents/multimodal.json"
  },
  "agents": {
    "dirs": ["./direct-agents"]
  },
  "taskPreparation": {
    "mode": "never"
  },
  "executionRouting": {
    "mode": "adaptive",
    "maxSpecialists": 2,
    "lowConfidenceFallback": "error"
  },
  "agentSelection": {
    "engine": "typesafe",
    "typesafe": {
      "model": "jev-latest",
      "apiKeyEnv": "TYPESAFE_API_KEY",
      "policy": {
        "relevance": {
          "instructions": "Is this profile a strong match for the objective and this specific attachment modality?"
        },
        "minimumRelevance": 0.3,
        "minimumConfidence": 0.4
      }
    }
  }
}
```

Run the same multimodal request:

```bash
adaptive-agent run \
  --cwd ./routing-manual \
  --enhance never \
  --image ./fixtures/red.png \
  --audio ./fixtures/tone.wav \
  --inspect \
  --output json \
  "Describe the image and audio together in one concise answer." \
  > routing-manual/phase-2-direct.json
```

Inspect the decision:

```bash
jq '{
  decision: .request.metadata.executionRouting,
  orchestration: .orchestration,
  resultStatus: .result.status
}' routing-manual/phase-2-direct.json
```

Expected invariants:

- `decision.mode` is `"direct"`, `decision.source` is `"typesafe"`, and
  `decision.primaryAgentId` is `"multimodal"`.
- One grouped assignment maps `text`, `image`, and `audio` to `multimodal`.
- `.orchestration` is absent because only one direct run is launched.
- `.result.status` is `"success"`.

## Compatibility checks

After the two adaptive tests:

1. Remove `executionRouting` (or set its mode to `"single"`) and rerun without
   `--orchestrate`. The existing one-profile selection path should be used.
2. Add an explicit `--agent ./agents/coordinator.json`. Adaptive routing should
   be bypassed because explicit agent selection remains fixed.
3. Add `--orchestrate`. The Phase 1 deterministic forced-orchestration path
   should be used instead of adaptive direct-versus-orchestration selection.

Missing capability metadata still means text-only. Agent SDK validates all
selected IDs, modality assignments, coverage, and `maxSpecialists` before any
execution stage starts; provider/runtime capability checks remain authoritative.
