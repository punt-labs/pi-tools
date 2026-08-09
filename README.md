# pi-tools

Shared Punt Labs pi extensions, skills, prompts, and themes.

This repo is for small pi-native utilities that are useful across projects but
not large enough to justify their own product repository. Larger tools with
engines, design docs, independent release cycles, or substantial state should
live in their own repos.

## Scope

Good fits for this repo:

- small pi extensions
- thin CLI wrappers
- shared prompt templates
- reusable skills
- lightweight status or tmux helpers

Poor fits:

- tools with a non-trivial engine
- tools with a separate CLI/server product
- tools needing their own release process
- project-specific extensions that only make sense in one repo

## Initial plan

The first likely extension is a small tmux helper for pi workflows. It should
start, inspect, send input to, and stop tmux sessions that host long-running CLI
processes.

## Development

This repo is Nix-first. The dev shell provides Node, npm, TypeScript tooling,
Beads, GitHub CLI, markdown linting, and shell tooling.

Nix is for development reproducibility. Published pi packages remain normal npm
or git package resources.
