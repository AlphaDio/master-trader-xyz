# Master Trader XYZ

Node.js CLI agent harness built around local `codex exec`.

The project is now focused on being a practical personal operator tool:

- run a workflow locally,
- keep durable state and artifacts,
- ask for only the missing input,
- enforce transaction guardrails,
- resume blocked runs cleanly.

## Requirements

- Node.js 22+
- Local `codex` CLI installed and authenticated

## Setup

```bash
npm install
copy .env.example .env
```

Then fill in the values you want to provide through environment variables.

## Commands

Run the default workflow once:

```bash
npm start
```

Or directly:

```bash
node src/index.js run-once
```

Resume a blocked run:

```bash
node src/index.js resume <run-id>
```

Print effective config:

```bash
node src/index.js config print
```

Manage skills:

```bash
node src/index.js skills list
node src/index.js skills check
node src/index.js skills import --tool codex
node src/index.js skills show <skill-id>
node src/index.js skills refresh <skill-id>
node src/index.js skills enable <skill-id>
node src/index.js skills disable <skill-id>
node src/index.js skills delete <skill-id>
```

Manage inbox requests:

```bash
node src/index.js inbox list
node src/index.js inbox show <request-id>
node src/index.js inbox answer <request-id>
node src/index.js inbox import <file-path>
```

## Default Workflow

The built-in workflow is the four-task crypto/Base sequence:

1. Collect price and market context
2. Analyze prices and portfolio state
3. Propose or perform guarded transactions
4. Evaluate the latest run

Override the workflow at runtime with `WORKFLOW_CONFIG_JSON` if needed.

## State Layout

Mutable state is stored under `state/`:

- `state/agent-state.json`
- `state/agent-memory.json`
- `state/skills/`
- `state/inbox/`
- `state/runs/`
- `state/secrets/`

Immutable run artifacts are stored under `artifacts/<run-id>/`.

## Skills

The harness can inspect and write skills in tool-specific skill directories. By default it knows about:

- `~/.codex/skills`
- `~/.claude/skills`
- `~/.cursor/skills`
- `~/.github/skills`
- `~/.opencode/skills`

Use `skills check` to see which targets exist and which skills are already installed there.

Use `skills import` to pull detected local skills into the agent's own registry.

Use `skills integrate <skill-id>` to install a registry-managed skill into one or more tool-specific directories.

## Input Requests

When Codex says a task needs human input, the harness creates a minimal inbox object and blocks the run cleanly.

For non-interactive runs, answer later through `inbox answer` or `inbox import`, then resume the run.

## Transaction Guardrails

Execution tasks inherit transaction guardrails from env-backed config before Codex runs and are checked again after Codex responds.

- `TRANSACTION_EXECUTION_MODE=dry-run|live`
- `TRANSACTION_REQUIRE_HUMAN_APPROVAL=true|false`
- `TRANSACTION_MAX_ACTIONS=<integer>`
- `TRANSACTION_MAX_AMOUNT_PER_ACTION=<number>`
- `TRANSACTION_ALLOWED_ASSETS=<comma-separated symbols>`
- `TRANSACTION_BLOCKED_ASSETS=<comma-separated symbols>`
- `TRANSACTION_ALLOWED_ACTION_TYPES=<comma-separated action types>`
- `TRANSACTION_BLOCKED_ACTION_TYPES=<comma-separated action types>`

Default behavior is conservative:

- execution mode is `dry-run`
- human approval is required for live actions
- more than 3 actions in one execution task is rejected
- `approve_unlimited`, `bridge`, and `deploy_contract` are blocked unless you override them

## Notes

- Skills are opt-in. They are only attached when selected by workflow config or `DEFAULT_SKILL_IDS`.
- Prompts and saved artifacts are redacted before persistence.
- The harness aggregates `external_calls` and `state_changes` into run state and per-task artifacts for later evaluation.
- Archived workflow examples can remain in `examples/`, but they are no longer the primary path through the project.
