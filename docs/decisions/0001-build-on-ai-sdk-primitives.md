# ADR-0001: Build on AI SDK primitives, no parallel types

Status: **Accepted** · Date: 2026-09-29

## Context

Every harness we built before defined its own `Part`, `Turn`, `AgentEvent` and event protocol,
then wrote converters to and from AI SDK types. Converters drift, lose provider metadata and
double the surface to test. AI SDK v7 already has `UIMessage` (with typed data parts and
metadata), `UIMessageChunk` streams, `tool()`, `toolSearch()`, `convertToModelMessages` and
`validateUIMessages`.

## Decision

eharness uses AI SDK types and functions directly for messages, streams, tools and models. Our
own types only add what AI SDK does not have (plugins, sessions, registries, adapters) and are
expressed *in terms of* AI SDK types (`HarnessUIMessage = UIMessage<…>`).

## Consequences

+ Frontends use `useChat` and `readUIMessageStream` without adapters (`@ai-sdk/tui` needs the
  `Agent`-interface adapter from the roadmap).
+ New AI SDK features (tool search, approvals, telemetry) flow through with little work.
− We are coupled to AI SDK major versions; `ai` is a peer dependency and a new AI SDK major is a
  new eharness major (see api-stability.md).

## Alternatives considered

- Own event protocol (rejected: duplicated converters, as in the predecessor).
