# Documents with Sections - Second Section Analysis

This report identifies documents containing level-2 sections (`##`) and lists the title of their second section.

## Summary

Found **17 documents** with multiple level-2 sections. Here are the second section titles for each:

| Document | First Section | Second Section |
|----------|--------------|----------------|
| `adaptive-agent-gateway-diagrams.md` | `## 0. Executive View: Thin Gateway, Tool-Centric Core` | `## 1. High-Level Architecture` |
| `adaptive-agent-gateway-proposal.md` | `## Overview` | `## Goals` |
| `agen-contracts-v1.3.md` | `## 1. TypeScript Contracts` | `## 2. Postgres Schema` |
| `agen-contracts-v1.4-multi-agent.md` | `## 1. Scope And Constraints` | `## 2. TypeScript Contract Delta` |
| `agen-contracts-v1.4.md` | `## 1. TypeScript Contracts` | `## 2. Contract Notes` |
| `agen-contracts-v1.5.md` | `## 1. Updated TypeScript Contracts` | `## 2. Provider Adapter Clarifications` |
| `agen-design-v2-parallel-children.md` | `## 1. Motivation` | `## 2. Design Goals And Constraints` |
| `agen-runtime-v1.4-algorithms.md` | `## 1. Core Invariants` | `## 2. Delegate Tool Registration` |
| `agen-spec-v1.4.md` | `## 1. Product Goal` | `## 2. Design Rules` |
| `agen-spec-v1.5.md` | `## 1. Scope` | `## 2. What Changed From v1.4` |
| `agen-v1.4-research-budget-plan.md` | `## Purpose` | `## Current Context` |
| `AGENT-SDK-CLI.md` | `## Current Starting Point` | `## Design Goals` |
| `agent-sdk-diagram.md` | `## 0. Executive View: CLI Setup, Durable Core` | *(single top-level section, no clear second)* |
| `AGENT-SDK.md` | `## Purpose` | `## Naming` |
| `AGENTS.md` | `## Current repository status` | `## Runtime and verification` |
| `archive/2026-04-08-file-log-performance-analyzer/progress.txt` | `## Codebase Patterns` | `## 2026-04-04 19:23:30 +0530 - US-001` |
| `artifacts/adaptive-gateway.md` | `## Overview` | `## Goals` |

## Notes

- Most documents follow a numbered section format (e.g., "## 1.", "## 2.")
- Some use descriptive titles without numbering (e.g., "## Overview", "## Goals")
- The document `agent-sdk-diagram.md` appears to have only one major top-level section
- Some documents in subdirectories like `archive/` and `artifacts/` were also analyzed

## Methodology

Used regex pattern `^## ` to identify all level-2 markdown headers across the workspace, then extracted the first two sections from each file that contained multiple sections.
