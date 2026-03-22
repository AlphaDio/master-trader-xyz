import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildCodexTaskResponseSchema } from "./schemas.js";
import { ensureDir, nowIso, redactValue, safeJsonStringify, writeJson, writeText } from "./utils.js";

const MAX_COMMAND_EVENTS_BEFORE_ABORT = 8;

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
  const promptPath = path.join(artifactDir, `${artifactPrefix}-prompt.txt`);
  const stdoutPath = path.join(artifactDir, `${artifactPrefix}-stdout.log`);
  const stderrPath = path.join(artifactDir, `${artifactPrefix}-stderr.log`);
  const eventsJsonlPath = path.join(artifactDir, `${artifactPrefix}-events.jsonl`);
  const eventsJsonPath = path.join(artifactDir, `${artifactPrefix}-events.json`);
  const lastMessagePath = path.join(artifactDir, `${artifactPrefix}-last-message.json`);
  const executionPath = path.join(artifactDir, `${artifactPrefix}-execution.json`);

  writeJson(schemaPath, schema);
  writeText(promptPath, redactPrompt(prompt, redactions));
  writeText(stdoutPath, "");
  writeText(stderrPath, "");
  writeText(eventsJsonlPath, "");

  const args = buildCodexArgs(config, schemaPath);
  const startedAt = nowIso();
  const executionState = {
    status: "running",
    started_at: startedAt,
    command: config.codex.bin,
    args,
    pid: null,
    timeout_ms: config.codex.taskTimeoutMs,
    stdout_bytes: 0,
    stderr_bytes: 0,
    last_output_at: null,
    abort_reason: null
  };
  writeExecutionState(executionPath, executionState);

  let result;
  try {
    result = await spawnWithInput({
      command: config.codex.bin,
      args,
      input: prompt,
      cwd: config.codex.workdir,
      timeoutMs: config.codex.taskTimeoutMs,
      onSpawn: (child) => {
        executionState.pid = child.pid || null;
        writeExecutionState(executionPath, executionState);
      },
      onStdout: (chunkText) => {
        const redactedChunk = redactPrompt(chunkText, redactions);
        fs.appendFileSync(stdoutPath, redactedChunk, "utf8");
        executionState.stdout_bytes += Buffer.byteLength(chunkText);
        executionState.last_output_at = nowIso();
        writeExecutionState(executionPath, executionState);
      },
      onStderr: (chunkText) => {
        const redactedChunk = redactPrompt(chunkText, redactions);
        fs.appendFileSync(stderrPath, redactedChunk, "utf8");
        executionState.stderr_bytes += Buffer.byteLength(chunkText);
        executionState.last_output_at = nowIso();
        writeExecutionState(executionPath, executionState);
      },
      onEvent: (event) => {
        fs.appendFileSync(eventsJsonlPath, `${safeJsonStringify(redactValue(event, redactions))}\n`, "utf8");
      },
      onAbort: (reason) => {
        executionState.abort_reason = reason;
        executionState.last_output_at = nowIso();
        writeExecutionState(executionPath, executionState);
      }
    });
  } catch (error) {
    writeExecutionState(executionPath, {
      ...executionState,
      status: "failed",
      finished_at: nowIso(),
      error: error.message
    });
    throw error;
  }

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

  writeJson(eventsJsonPath, redactValue(events, redactions));
  writeJson(lastMessagePath, redactedParsed);
  writeExecutionState(executionPath, {
    ...executionState,
    status: result.abortedForExploration ? "aborted" : result.timedOut ? "timed_out" : "completed",
    started_at: startedAt,
    command: config.codex.bin,
    args,
    exit_code: result.exitCode,
    timed_out: result.timedOut === true,
    aborted_for_exploration: result.abortedForExploration === true,
    abort_reason: result.abortReason || executionState.abort_reason,
    finished_at: nowIso()
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    abortedForExploration: result.abortedForExploration === true,
    abortReason: result.abortReason || null,
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

const SKILL_MARKDOWN_MAX_CHARS = 2000;
const PRIOR_OUTPUT_MAX_CHARS = 300;

function truncate(text, maxChars) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated, ${text.length - maxChars} chars omitted]`;
}

function summarizePriorResults(priorTaskResults) {
  if (!Array.isArray(priorTaskResults) || priorTaskResults.length === 0) {
    return "[]";
  }
  const summarized = priorTaskResults.map((result) => {
    const outputStr = typeof result.output === "string"
      ? result.output
      : safeJsonStringify(result.output);
    return {
      task_id: result.task_id,
      status: result.status,
      output_summary: truncate(outputStr, PRIOR_OUTPUT_MAX_CHARS)
    };
  });
  return JSON.stringify(summarized);
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
          skill.summary ? `Skill Summary: ${skill.summary}` : null,
          "Skill Metadata JSON:",
          safeJsonStringify(skill.metadata),
          "Skill Markdown:",
          truncate(skill.raw_markdown, SKILL_MARKDOWN_MAX_CHARS)
        ].filter(Boolean).join("\n"))
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

  const synthesisRegistrationRules = task.id === "register-for-synthesis"
    ? [
        "Synthesis Registration Rules:",
        "- If required human registration fields are missing, return blocked_waiting_for_input and ask only for the missing fields.",
        "- Do not classify missing human registration fields as status blocked.",
        "- For missing human registration data, create one input_request field per missing value. Do not combine multiple required registration values into a single free-form field.",
        "- Use these exact keys when needed: humanInfo.name, humanInfo.email, humanInfo.background, humanInfo.cryptoExperience, humanInfo.aiAgentExperience, humanInfo.codingComfort, humanInfo.problemToSolve, humanInfo.verificationMethod.",
        "- Keep labels short and specific, for example Full name, Email address, Background, Crypto experience, AI agent experience, Coding comfort, Problem to solve, Verification method.",
        "- Use status blocked only for non-human blockers such as missing POST capability, unreachable endpoints, missing permissions, or unavailable upstream services.",
        "- If both human input and environment blockers exist, prefer blocked_waiting_for_input so the missing human fields can be collected for a later retry.",
        "- If registration is externally blocked, record that clearly in execution.external_calls and explain what later retry condition is needed.",
        ""
      ]
    : [];
  const requiredHumanFields = Array.isArray(taskContext.task_specific?.required_human_profile_fields)
    ? taskContext.task_specific.required_human_profile_fields
    : [];
  const requiredHumanFieldRules = requiredHumanFields.length > 0
    ? [
        "Required Human Fields:",
        ...requiredHumanFields.map((field) => `- ${field}`),
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
    "- Treat the provided task context and memory as authoritative unless the task explicitly requires new local inspection.",
    "- Do not explore the repository or enumerate workspace files unless the task explicitly requires a named local file or artifact.",
    "- Do not run broad discovery commands such as `rg --files`, `Get-ChildItem`, or recursive scans unless they are strictly necessary for the task output.",
    "- Prefer returning a best-effort structured result over open-ended exploration.",
    "- If you can complete the task, return status completed, partial, failed, or blocked.",
    "- If you cannot proceed because you need human-provided data, return status blocked_waiting_for_input.",
    "- Use status blocked when the task is prevented by an external dependency or environment constraint such as missing network access, unreachable APIs, missing permissions, missing tooling, or unavailable upstream services.",
    "- input_request must always be present. Use {\"prompt\":\"\",\"fields\":[]} when no human input is needed.",
    "- state_changes must always be present. Use [] when no durable values need to be saved.",
    "- requested_operations must always be present. Use [] when no harness-executed operation is needed.",
    "- task_checkpoint must always be present. Use {\"entries\":[]} when you have no resumable intermediate state to save for the next round.",
    "- Because the schema is strict, always fill every output property. Use null when the output schema allows it; otherwise use empty strings, 0, empty arrays, or empty objects when a field is not available.",
    "- When blocked_waiting_for_input, still return an output object that matches the schema using placeholder values where necessary.",
    "- When blocked, explain the blocking dependency in execution.external_calls, journal events, output notes, and next_step if the schema has one.",
    "- input_request must only ask for the minimum missing fields needed to continue.",
    "- Use state_changes to persist reusable values discovered during the task, such as handles, IDs, URLs, tokens, credentials, or checkpoints needed by later tasks or future runs.",
    "- Use state_changes scope run for values that only matter in this workflow run, and scope agent for values that should be reusable in future runs.",
    "- Use task_checkpoint.entries for intermediate protocol state that helps the same task continue across repeated operation rounds, such as pending IDs, cursors, challenges, partial API responses, or next-step hints.",
    "- Each task_checkpoint entry must use a unique key and put the JSON-serialized value in value_json.",
    "- For secret state_changes, set sensitivity to secret, put the raw value in value, and set secret_ref to null. The harness will store the secret and replace it with a reference.",
    "- Use execution.external_calls to record meaningful external interactions such as HTTP requests, RPC queries, wallet actions, browser operations, or CLI calls.",
    "- If you need the harness to perform an HTTP call, request it via requested_operations instead of declaring the environment blocked.",
    "- requested_operations currently supports kind=http_request with method, url, headers, body, body_format, and purpose.",
    "- If body_format is json, body must be a JSON string.",
    "- After requested_operations are executed, their results will appear in taskContext.operation_results on the next attempt.",
    "- The prior task_checkpoint will appear in taskContext.task_checkpoint on the next attempt.",
    "- Do not repeat the same requested operation after a successful result is already present unless the task truly requires a retry.",
    "- reasoning must be one sentence.",
    "",
    ...transactionRules,
    ...synthesisRegistrationRules,
    ...requiredHumanFieldRules,
    "Selected Skills:",
    skillBlocks,
    "",
    "Task Context JSON:",
    JSON.stringify(taskContext),
    "",
    "Prior Task Results JSON:",
    summarizePriorResults(priorTaskResults),
    ""
  ].join("\n");
}

function spawnWithInput({ command, args, input, cwd, timeoutMs, onSpawn, onStdout, onStderr, onEvent, onAbort }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      windowsHide: true
    });
    onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let abortedForExploration = false;
    let abortReason = null;
    let timeoutId = null;
    const explorationState = {
      commandEvents: 0,
      sawAgentMessage: false
    };

    const processEventLines = (streamName) => {
      const isStdout = streamName === "stdout";
      const buffer = isStdout ? stdoutBuffer : stderrBuffer;
      const lines = buffer.split(/\r?\n/);
      const trailing = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("{")) {
          continue;
        }

        try {
          const event = JSON.parse(line);
          onEvent?.(event);
          if (shouldAbortForExploration(event, explorationState)) {
            abortedForExploration = true;
            abortReason = `Aborted after ${explorationState.commandEvents} command events without a meaningful agent response.`;
            onAbort?.(abortReason);
            void terminateProcessTree(child);
          }
        } catch {
          // Ignore non-JSON lines in the live stream.
        }
      }

      if (isStdout) {
        stdoutBuffer = trailing;
      } else {
        stderrBuffer = trailing;
      }
    };

    child.stdout.on("data", (chunk) => {
      const chunkText = chunk.toString();
      stdout += chunkText;
      stdoutBuffer += chunkText;
      onStdout?.(chunkText);
      processEventLines("stdout");
    });

    child.stderr.on("data", (chunk) => {
      const chunkText = chunk.toString();
      stderr += chunkText;
      stderrBuffer += chunkText;
      onStderr?.(chunkText);
      processEventLines("stderr");
    });

    child.on("error", reject);

    child.on("close", (exitCode) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      resolve({ exitCode, stdout, stderr, timedOut, abortedForExploration, abortReason });
    });

    if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child);
      }, timeoutMs);
    }

    child.stdin.write(input);
    child.stdin.end();
  });
}

function redactPrompt(text, redactions) {
  return redactValue(text, redactions);
}

function writeExecutionState(filePath, executionState) {
  writeJson(filePath, executionState);
}

function shouldAbortForExploration(event, explorationState) {
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    explorationState.sawAgentMessage = true;
  }

  if (explorationState.sawAgentMessage) {
    return false;
  }

  if (event.item?.type === "command_execution" && (event.type === "item.started" || event.type === "item.completed")) {
    explorationState.commandEvents += 1;
  }

  return explorationState.commandEvents > MAX_COMMAND_EVENTS_BEFORE_ABORT;
}

function terminateProcessTree(child) {
  return process.platform === "win32"
    ? terminateWindowsProcessTree(child.pid)
    : terminatePosixProcessTree(child.pid);
}

function terminateWindowsProcessTree(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve();
      return;
    }

    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.on("error", () => {
      resolve();
    });

    killer.on("close", () => {
      resolve();
    });
  });
}

function terminatePosixProcessTree(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve();
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        resolve();
        return;
      }
    }

    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Ignore best-effort kill failures.
        }
      }
      resolve();
    }, 1000);
  });
}
