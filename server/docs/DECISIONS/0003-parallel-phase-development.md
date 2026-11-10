# 0003: One phase per supervised subagent

Date: 6 November 2026. Status: explicitly authorized by the owner.

## Context

The master specification orders phase execution. The owner subsequently requested at most three GPT-6.1 Terra subagents with xhigh reasoning, one different phase per subagent, with the parent supervising their work.

## Decision

Assign one agent P0, one P1 and one P2. Each owns its phase files and tests, coordinates public contracts with dependencies, and avoids editing another phase's files. The parent owns dependency/toolchain configuration, shared documentation/manifests, integration review and independent verification.

Implement independent parts concurrently, but accept phases in dependency order. No phase is declared complete based on stubs, mocked integration services, skipped tests or a sibling's unverified claim. A phase cannot bypass a required transaction/security contract because its dependency is still being built. Keep the master specification intact and record actual evidence in PROGRESS.md.

## Consequences

This explicit owner instruction supersedes the earlier requirement to delay all later-phase coding until the preceding phase is green. It does not remove acceptance gates. Only three subagents are active; the parent remains responsible for integration and reporting limitations accurately.
