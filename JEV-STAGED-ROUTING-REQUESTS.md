# Staged TypeSafe Routing Requests

## Scope

This documents the opt-in `selectStagedExecutionRoutingWithTypeSafe` API in
`packages/agent-sdk/src/adaptive-execution-routing.ts`. The JEV routing study
uses it when `executionRouting.mode` is `adaptive`. CLI and desktop-bridge still
use the existing combined TypeSafe request through `decideAutomaticRun`; the
examples below do not describe their current wire requests. No agent executes
during a study evaluation.

Each stage calls `client.evaluate({ model, state, questions })`. The SDK first
filters out archived, invalid, and non-`run` profiles. Absent or empty
`capabilities.modalitiesSupported` means `['text']`. Every request contains the
original objective, attachment *types and counts*, and safe catalog summaries;
it does not read referenced files or send attachment paths, profile config
paths, credentials, or profile system instructions. Candidate indexes in a
question refer to the `candidates` array of **that stage's** state, not the
unfiltered catalog.

For illustration, the policy snippets below use these values (a real request
uses the effective policy from settings):

```json
{
  "relevance": {
    "instructions": "Does this profile fit the objective and assigned input?",
    "criteria": { "true": "It can do the work.", "false": "It cannot do the work." }
  },
  "selection": {
    "instructions": "Choose the best single profile.",
    "candidateCriteria": "Prefer the narrowest capable profile."
  },
  "routing": {
    "modeInstructions": "Choose direct unless a specialist adds value.",
    "primaryInstructions": "Choose the owner and synthesizer.",
    "assignmentInstructions": "Choose the best profile for this modality."
  },
  "minimumConfidence": 0.3,
  "minimumRelevance": 0.3
}
```

The study passes the same question guidance but temporarily sets both minima
to zero to collect low-scoring decisions; it then reports acceptance against
the configured minima. Production adoption would apply the configured minima
inside Agent SDK.

## Stage 1: execution mode

For the text-only objective `Implement a code change`, suppose two eligible
profiles are `coding-assistant` and `synthesize-agent`. The mode request is:

```json
{
  "model": "jev-1.13.0",
  "state": {
    "objective": "Implement a code change",
    "attachments": {
      "types": ["text"],
      "counts": { "images": 0, "files": 0, "audio": 0 }
    },
    "candidates": [
      { "id": "coding-assistant", "name": "Coding Assistant", "description": "Edits and tests code.", "modalities": ["text"], "tools": ["read_file", "shell"] },
      { "id": "synthesize-agent", "name": "Synthesizer", "description": "Synthesizes specialist results.", "modalities": ["text"], "tools": [] }
    ],
    "limits": { "maxSpecialists": 4 }
  },
  "questions": {
    "execution_mode": {
      "type": "choice",
      "instructions": "Choose direct unless a specialist adds value.",
      "criteria": {
        "direct": "One eligible profile can own and complete the entire objective.",
        "orchestration": "A distinct specialist contribution is useful and can be represented by the supplied modalities."
      }
    }
  }
}
```

This call has **no candidate-relevance or assignment questions**. The mode
response's choice and confidence select the next branch. If no profile covers
all detected modalities, the mode is deterministically `orchestration`; with
only one eligible profile, it is deterministically `direct`. Those cases skip
this API call and record a mode confidence of 1 with no mode-stage token usage.
Otherwise, a low mode confidence fails the configured confidence gate before
asking the second-stage questions when the staged API is used with its actual
thresholds. The study's zero-threshold override instead records that decision
for comparison.

## Stage 2A: direct profile selection

If the mode answer is `direct`, the SDK calls
`selectAgentProfileWithTypeSafe` with only profiles that cover **text plus all
attachments**. For the two text-capable profiles above, the state now uses the
selector's full safe summaries. Unlike the mode request, `attachments.types`
is empty for text-only input: it lists only supplied image/file/audio types.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "objective": "Implement a code change",
    "attachments": {
      "types": [],
      "counts": { "images": 0, "files": 0, "audio": 0 }
    },
    "candidates": [
      { "id": "coding-assistant", "name": "Coding Assistant", "description": "Edits and tests code.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": ["read_file", "shell"], "delegates": [], "capabilities": { "modalitiesSupported": ["text"] } },
      { "id": "synthesize-agent", "name": "Synthesizer", "description": "Synthesizes specialist results.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": [], "delegates": [], "capabilities": { "modalitiesSupported": ["text"] } }
    ]
  },
  "questions": {
    "candidate_0_relevant": {
      "type": "noul",
      "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "attachmentTypes": "`attachments.types`", "candidate": "`candidates[0]`" },
      "criteria": { "true": "It can do the work.", "false": "It cannot do the work." }
    },
    "candidate_1_relevant": {
      "type": "noul",
      "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "attachmentTypes": "`attachments.types`", "candidate": "`candidates[1]`" },
      "criteria": { "true": "It can do the work.", "false": "It cannot do the work." }
    },
    "selection": {
      "type": "choice",
      "instructions": "Choose the best single profile.",
      "criteria": {
        "coding-assistant": {
          "profile": { "id": "coding-assistant", "name": "Coding Assistant", "description": "Edits and tests code.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": ["read_file", "shell"], "delegates": [], "capabilities": { "modalitiesSupported": ["text"] } },
          "guidance": "Prefer the narrowest capable profile."
        },
        "synthesize-agent": {
          "profile": { "id": "synthesize-agent", "name": "Synthesizer", "description": "Synthesizes specialist results.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": [], "delegates": [], "capabilities": { "modalitiesSupported": ["text"] } },
          "guidance": "Prefer the narrowest capable profile."
        }
      }
    }
  }
}
```

The selected profile's relevance is the `noul` answer for its index. With a
single eligible direct profile, the `selection` choice is omitted; the SDK
still asks for that profile's relevance. Direct execution assigns every
detected modality, including text, to the selected profile.

## Stage 2B: orchestration assignments

For a separate objective, `Analyze an image and audio, then summarize`, assume
these ordered profiles: `general` supports text/image/audio; `vision` supports
image; `transcriber` supports audio. If stage 1 chooses `orchestration`, stage 2
uses the full safe summaries and asks only these questions:

```json
{
  "model": "jev-1.13.0",
  "state": {
    "objective": "Analyze an image and audio, then summarize",
    "attachments": {
      "types": ["text", "image", "audio"],
      "counts": { "images": 1, "files": 0, "audio": 1 }
    },
    "candidates": [
      { "id": "general", "name": "General", "description": "Owns and synthesizes results.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": [], "delegates": [], "capabilities": { "modalitiesSupported": ["text", "image", "audio"] } },
      { "id": "vision", "name": "Vision", "description": "Analyzes images.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": [], "delegates": [], "capabilities": { "modalitiesSupported": ["image"] } },
      { "id": "transcriber", "name": "Transcriber", "description": "Analyzes audio.", "invocationModes": ["run"], "defaultInvocationMode": "run", "tools": [], "delegates": [], "capabilities": { "modalitiesSupported": ["audio"] } }
    ],
    "limits": { "maxSpecialists": 2 }
  },
  "questions": {
    "candidate_0_text_relevant": { "type": "noul", "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "modality": "text", "candidate": "`candidates[0]`" }, "criteria": { "true": "It can do the work.", "false": "It cannot do the work." } },
    "candidate_0_image_relevant": { "type": "noul", "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "modality": "image", "candidate": "`candidates[0]`" }, "criteria": { "true": "It can do the work.", "false": "It cannot do the work." } },
    "candidate_0_audio_relevant": { "type": "noul", "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "modality": "audio", "candidate": "`candidates[0]`" }, "criteria": { "true": "It can do the work.", "false": "It cannot do the work." } },
    "candidate_1_image_relevant": { "type": "noul", "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "modality": "image", "candidate": "`candidates[1]`" }, "criteria": { "true": "It can do the work.", "false": "It cannot do the work." } },
    "candidate_2_audio_relevant": { "type": "noul", "instructions": { "question": "Does this profile fit the objective and assigned input?", "objective": "`objective`", "modality": "audio", "candidate": "`candidates[2]`" }, "criteria": { "true": "It can do the work.", "false": "It cannot do the work." } },
    "candidate_0_primary_relevant": { "type": "noul", "instructions": { "question": "Can this primary own the objective and synthesize specialist results?", "objective": "`objective`", "candidate": "`candidates[0]`" }, "criteria": { "true": "It can do the work.", "false": "It cannot do the work." } },
    "assignment_image": {
      "type": "choice",
      "instructions": { "question": "Choose the best profile for this modality.", "candidateCriteria": "Prefer the narrowest capable profile." },
      "criteria": { "general": { "profile": "`candidates[0]`" }, "vision": { "profile": "`candidates[1]`" } }
    },
    "assignment_audio": {
      "type": "choice",
      "instructions": { "question": "Choose the best profile for this modality.", "candidateCriteria": "Prefer the narrowest capable profile." },
      "criteria": { "general": { "profile": "`candidates[0]`" }, "transcriber": { "profile": "`candidates[2]`" } }
    }
  }
}
```

There is no `execution_mode` question in this second call. With only one
text-capable candidate, `orchestration_primary` and `assignment_text` are
omitted and deterministically resolve to `general`. With multiple eligible
primaries, `orchestration_primary` is a `choice` using
`routing.primaryInstructions`, the shared `selection.candidateCriteria`, and
profile references. Each additional modality with multiple eligible profiles
gets an `assignment_<modality>` choice using `routing.assignmentInstructions`.
All eligible candidate/modality pairs still get a relevance question; a
text-capable primary also gets a separate synthesis-relevance question.

The SDK groups assignments by agent ID, validates every assigned modality and
the configured specialist limit, and requires a specialist distinct from the
primary. If independent top choices exceed `maxSpecialists`, it searches the
returned positive-probability alternatives for the highest joint-probability
valid assignment; it does not make another TypeSafe call. It rejects the result
if no valid assignment exists. Choice confidence is the minimum of the used
mode, primary, and assignment choice scores (a reranked alternative uses its
probability); relevance is the minimum of the used assignment and primary
synthesis relevance scores. The study reports both separately. `text` is one
modality, not a decomposition into multiple text subtasks.

For a fresh study evaluation, `--show-state --output json` includes each
stage's actual state and question keys; `--show-response` includes the returned
answers. These diagnostic flags may expose the objective and catalog summaries
in terminal output. They do not include file contents or attachment paths.
