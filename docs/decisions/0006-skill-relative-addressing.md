# ADR-0006: Skill files are addressed relative to the skill

Status: **Accepted** · Date: 2026-09-29

## Context

Skills can be static (in code), in a filesystem plugin, in a database or remote. If skill file
paths were filesystem paths, static skills could not have files and moving a skill would break its
`SKILL.md` references.

## Decision

The canonical address is `(skillName, relativePath)`. Tools `load_skill` / `read_skill_file`
resolve through `SkillSource`. Physical paths appear only when an executor plugin materializes a
skill (via `locate()` and the `skill.load` hook).

## Consequences

+ Sources are interchangeable; path traversal is impossible by construction.
− Executing skill scripts needs an executor plugin (future sandbox).

## Alternatives considered

- Expose skills through file tools (rejected: couples skills to one filesystem, lets agents edit skills).
