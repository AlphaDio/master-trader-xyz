# Master Trader XYZ

Node.js CLI agent harness built around local `codex exec`.

It now supports:

- first-class Markdown skills stored in a local registry,
- checking installed skills across known agent skill directories,
- importing detected skills into the local registry,
- integrating managed skills back into agent-specific skill directories,
- persisting per-target integration state inside the local skill registry,
- ordered workflow tasks with strict JSON schemas,
- JSON state and immutable run artifacts,
- blocked/resume runs via inbox request objects,
- direct CLI prompting or async inbox answering,
- generic run-scoped and agent-scoped durable state changes returned by Codex,
- durable agent memory for reusable non-secret values and secret references across runs,
- persisted external-call receipts for audit and later evaluation,
- run-level evaluation after execution,
- transaction guardrails enforced by the Node.js harness.

There is no internal cron daemon. It is a Node.js process you invoke directly.

## Requirements

- Node.js 22+
- Local `codex` CLI installed and authenticated

## Setup

```bash
npm install
copy .env.example .env
```

Then fill in the values you want to provide through environment variables.

## Default Workflow

The built-in workflow is still the four-task crypto/Base sequence:

1. Find a way to get the best prices data in crypto on Base, and record them
2. Analyze the prices and get intel from it and analyze the present state of the portfolio
3. Make transactions to grow or secure the value of the portfolio
4. Evaluate the latest run

Override the workflow at runtime with `WORKFLOW_CONFIG_JSON` if needed.

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

Manage skills:

```bash
node src/index.js skills add --url https://synthesis.devfolio.co/skill.md --name synthesis
node src/index.js skills list
node src/index.js skills check
node src/index.js skills import --tool codex
node src/index.js skills integrate synthesis --tool codex
node src/index.js skills show synthesis
node src/index.js skills refresh synthesis
node src/index.js skills remove synthesis
node src/index.js skills disable synthesis
node src/index.js skills enable synthesis
node src/index.js skills delete synthesis
```

Manage inbox requests:

```bash
node src/index.js inbox list
node src/index.js inbox show <request-id>
node src/index.js inbox answer <request-id>
node src/index.js inbox import <file-path>
```

Print effective config:

```bash
node src/index.js config print
```

## Synthesis Entry

The repository is now set up to be entered into The Synthesis through the local harness, not just to store the skill.

Recommended operator setup:

1. Put `synthesis` in `DEFAULT_SKILL_IDS`.
2. Set `AGENT_CONTEXT_JSON` with an `agentProfile` object containing at least `name`, `description`, `agentHarness`, and `model`.
3. Keep `TRANSACTION_EXECUTION_MODE=dry-run` while registering and preparing the submission.
4. Use the ready-made workflow in [`examples/synthesis-entry-workflow.json`](./examples/synthesis-entry-workflow.json) by loading it into `WORKFLOW_CONFIG_JSON`.

If you want registration to coexist with the trading workflow, use [`examples/synthesis-trader-workflow.json`](./examples/synthesis-trader-workflow.json). It gives `synthesis` only to the registration task and keeps the market-analysis, execution, and evaluation tasks free of default skills.

Example PowerShell flow:

```powershell
$env:DEFAULT_SKILL_IDS="synthesis"
$env:WORKFLOW_CONFIG_JSON=Get-Content .\examples\synthesis-entry-workflow.json -Raw
node .\src\index.js run-once
```

That workflow is designed to:

- register the agent for The Synthesis,
- block only when human verification input is required,
- persist registration handles and secrets for resume,
- leave behind a submission plan after entry.

## State Layout

Mutable state is stored under `state/`:

- `state/agent-state.json`
- `state/agent-memory.json`
- `state/skills/`
- `state/inbox/`
- `state/runs/`
- `state/secrets/`

Immutable run artifacts are stored under `artifacts/<run-id>/`.

## Skill Targets

The harness can inspect and write skills in tool-specific skill directories. By default it knows about:

- `~/.codex/skills`
- `~/.claude/skills`
- `~/.cursor/skills`
- `~/.github/skills`
- `~/.opencode/skills`

Use `skills check` to see which targets exist and which skills are already installed there.

Use `skills import` to pull detected local skills into the agent's own registry.

Use `skills integrate <skill-id>` to install a registry-managed skill into one or more tool-specific directories. File-backed skills are copied as full packages when possible; URL-backed skills are written as a `SKILL.md` package.

Use `skills remove <skill-id>` to exclude a skill from consideration without deleting it from the registry or uninstalling it from any tool directory. Use `skills delete <skill-id>` only when you want to remove the registry record itself.

The registry now stores per-target installation records for each managed skill, including install path, mode, and last-seen status.

At workflow startup, the harness synchronizes existing integration records and auto-imports required missing skills when they are already installed in detected target directories.

Per-task skill control:

- `default_skill_ids` are the run-level defaults.
- Set `use_default_skills` to `false` on any task that should not inherit those defaults.
- Set `skill_ids` on a task when you want an explicit skill set for that task.

Task-level execution hints:

- You can place extra execution hints inside a task's `context` to narrow Codex's search space.
- Useful keys include `allowed_tools`, `forbidden_actions`, `preferred_sources`, `max_external_calls`, and `expected_artifacts`.
- The intended use is to tell the model what sources or actions are acceptable for that task, for example forbidding repository scans on a market-data task or limiting the task to a known API and one output artifact.

## Input Requests

When Codex says a task needs human input, the harness creates a minimal inbox object:

```json
{
  "id": "req_123",
  "run_id": "run_123",
  "task_id": "task_1",
  "skill_id": "synthesis",
  "status": "open",
  "prompt": "Please provide the missing registration details.",
  "fields": [
    {
      "key": "humanInfo.email",
      "label": "Email",
      "required": true,
      "secret": false,
      "hint": "",
      "value": null,
      "secret_ref": null
    }
  ]
}
```

For non-interactive runs, answer later through `inbox answer` or `inbox import`, then resume the run.

## Secrets

- Long-lived operator secrets come from env vars listed in `AGENT_SECRET_KEYS`.
- Secret answers gathered during a run are stored separately under `state/secrets/`.
- Secret values returned in task `state_changes` are also moved into `state/secrets/` and replaced with secret references.
- Prompts and saved artifacts are redacted before persistence.

## Durable State Changes

Tasks can now return `state_changes` alongside normal task output.

- Use scope `run` for handles or checkpoints only needed by later tasks in the current workflow run.
- Use scope `agent` for reusable values that should survive into future runs.
- Use sensitivity `secret` for credentials or confidential values; the harness will persist them as secret references instead of leaving raw values in artifacts.
- Blocked tasks can persist state changes before asking for more input, which lets later resume steps continue with saved pending IDs, URLs, or other intermediate handles.

The harness also aggregates redacted `external_calls` and `state_changes` into run state and per-task artifacts for later evaluation.

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

If Codex proposes actions that violate policy, the task is converted to a failed result and the run stops.

## Notes

- Skills are opt-in. They are only attached when selected by workflow config or `DEFAULT_SKILL_IDS`.
- Synthesis is just one skill among many possible Markdown skills.
- The harness does not implement exchange- or Synthesis-specific clients. It gives Codex the skill/context and records the structured result.
- Skill target discovery can be overridden with `SKILL_TARGETS_JSON` when you want custom locations or a narrower integration surface.
