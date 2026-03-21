import { spawn } from "node:child_process";
import path from "node:path";
import { buildCodexTaskResponseSchema } from "./schemas.js";
import { ensureDir, redactValue, safeJsonStringify, writeJson, writeText } from "./utils.js";

export async function runCodexTask({
  config,
  runId,
  workflow,
  task,
  taskIndex,
  taskContext,
  priorTaskResults,
  skillSnapshots,
  artifactsDir,
  attempt,
  redactions
}) {
  const taskDir = path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${task.id}`);
  const prompt = buildTaskPrompt({
    runId,
    workflow,
    task,
    taskIndex,
    taskContext,
    priorTaskResults,
    skillSnapshots
  });

  return runCodexStructured({
    config,
    schema: buildCodexTaskResponseSchema(task),
    prompt,
    artifactDir: taskDir,
    artifactPrefix: `attempt-${attempt}`,
    redactions
  });
}

export async function runCodexStructured({
  config,
  schema,
  prompt,
  artifactDir,
  artifactPrefix,
  redactions
}) {
  ensureDir(artifactDir);

  const schemaPath = path.join(artifactDir, `${artifactPrefix}-schema.json`);
  writeJson(schemaPath, schema);

  const args = buildCodexArgs(config, schemaPath);
  const result = await spawnWithInput({
    command: config.codex.bin,
    args,
    input: prompt,
    cwd: config.codex.workdir
  });

  const eventLines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];
  let lastAgentMessage = null;

  for (const line of eventLines) {
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      events.push(event);

      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastAgentMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON lines in the combined stream.
    }
  }

  const parsed = lastAgentMessage ? JSON.parse(lastAgentMessage) : null;
  const redactedParsed = parsed ? redactValue(parsed, redactions) : null;

  writeText(path.join(artifactDir, `${artifactPrefix}-prompt.txt`), redactPrompt(prompt, redactions));
  writeText(path.join(artifactDir, `${artifactPrefix}-stdout.log`), redactPrompt(result.stdout, redactions));
  writeText(path.join(artifactDir, `${artifactPrefix}-stderr.log`), redactPrompt(result.stderr, redactions));
  writeJson(path.join(artifactDir, `${artifactPrefix}-events.json`), redactValue(events, redactions));
  writeJson(path.join(artifactDir, `${artifactPrefix}-last-message.json`), redactedParsed);

  return {
    stdout: redactPrompt(result.stdout, redactions),
    stderr: redactPrompt(result.stderr, redactions),
    exitCode: result.exitCode,
    parsed,
    redactedParsed
  };
}

function buildCodexArgs(config, schemaPath) {
  const args = [];

  if (config.codex.enableWebSearch) {
    args.push("--search");
  }

  args.push(
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--output-schema",
    schemaPath
  );

  if (config.codex.model) {
    args.push("--model", config.codex.model);
  }

  if (config.codex.dangerousBypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", config.codex.sandboxMode);
  }

  args.push("-");
  return args;
}

function buildTaskPrompt({
  runId,
  workflow,
  task,
  taskIndex,
  taskContext,
  priorTaskResults,
  skillSnapshots
}) {
  const skillBlocks = skillSnapshots.length > 0
    ? skillSnapshots
        .map((skill) => [
          `Skill ID: ${skill.id}`,
          `Skill Title: ${skill.title}`,
          "Skill Metadata JSON:",
          safeJsonStringify(skill.metadata),
          "Skill Markdown:",
          skill.raw_markdown
        ].join("\n"))
        .join("\n\n---\n\n")
    : "No skills selected for this task.";

  const transactionRules = taskContext.transaction_guardrails
    ? [
        "Transaction Guardrails:",
        "- Respect transaction_guardrails exactly.",
        "- If transaction_guardrails.mode is dry-run, do not sign, broadcast, or fabricate live transaction hashes.",
        "- If transaction_guardrails.approval.required is true and approval.granted is false, return blocked_waiting_for_input before any live action.",
        "- If you need approval, request transaction_approval.approved and optionally transaction_approval.notes.",
        "- Never bypass blocked assets, blocked action types, amount limits, or action-count limits.",
        ""
      ]
    : [];

  return [
    "You are executing one task in a workflow orchestrated by a Node.js agent.",
    "Return only JSON that matches the provided schema.",
    "",
    `Run ID: ${runId}`,
    `Workflow ID: ${workflow.id}`,
    `Task Index: ${taskIndex + 1}`,
    `Task ID: ${task.id}`,
    `Goal: ${task.goal}`,
    "",
    "Rules:",
    "- Use the provided context, skills, URLs, and secrets as task inputs.",
    "- If you can complete the task, return status completed, partial, or failed.",
    "- If you cannot proceed because you need human-provided data, return status blocked_waiting_for_input.",
    "- input_request must always be present. Use {\"prompt\":\"\",\"fields\":[]} when no human input is needed.",
    "- state_changes must always be present. Use [] when no durable values need to be saved.",
    "- Because the schema is strict, always fill every output property. Use empty strings, 0, empty arrays, or empty objects when a field is not available.",
    "- When blocked_waiting_for_input, still return an output object that matches the schema using placeholder values where necessary.",
    "- input_request must only ask for the minimum missing fields needed to continue.",
    "- Use state_changes to persist reusable values discovered during the task, such as handles, IDs, URLs, tokens, credentials, or checkpoints needed by later tasks or future runs.",
    "- Use state_changes scope run for values that only matter in this workflow run, and scope agent for values that should be reusable in future runs.",
    "- For secret state_changes, set sensitivity to secret, put the raw value in value, and set secret_ref to null. The harness will store the secret and replace it with a reference.",
    "- Use execution.external_calls to record meaningful external interactions such as HTTP requests, RPC queries, wallet actions, browser operations, or CLI calls.",
    "- reasoning must be one sentence.",
    "",
    ...transactionRules,
    "Selected Skills:",
    skillBlocks,
    "",
    "Task Context JSON:",
    safeJsonStringify(taskContext),
    "",
    "Prior Task Results JSON:",
    safeJsonStringify(priorTaskResults),
    ""
  ].join("\n");
}

function spawnWithInput({ command, args, input, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function redactPrompt(text, redactions) {
  return redactValue(text, redactions);
}
