import path from "node:path";
import { loadConfig } from "./config.js";
import { runCodexTask } from "./codex.js";
import { evaluateRun } from "./evaluation.js";
import {
  answerInputRequestInteractive,
  applyInputRequestAnswers,
  createInputRequest,
  loadInputRequest,
  requestIsAnswered,
  saveInputRequest
} from "./inbox.js";
import { buildCodexTaskResponseSchema } from "./schemas.js";
import { redactTaskArtifacts, resolveRuntimeSecrets, storeSecretValue } from "./secrets.js";
import { resolveSkillsForRun, startupSyncSkills } from "./skills.js";
import {
  acquireRunLock,
  ensureStateLayout,
  getRunArtifactsDir,
  loadAgentMemory,
  loadRunState,
  releaseRunLock,
  saveAgentMemory,
  saveRunState,
  syncRunArtifact
} from "./state.js";
import { deepClone, getNestedValue, makeRunId, nowIso, safeJsonStringify, setNestedValue, writeJson } from "./utils.js";
import { validateOrThrow } from "./validation.js";

const MAX_OPERATION_ROUNDS_PER_TASK = 10;
const MAX_REPEATED_OPERATION_BATCHES = 3;

export async function runWorkflowOnce(options = {}) {
  const config = loadConfig();
  ensureStateLayout(config);
  const selectedSkillIds = resolveSelectedSkillIds(config);
  await startupSyncSkills(config, {
    fetchRemote: true,
    requiredSkillIds: collectConfiguredSkillIds(config.workflow, selectedSkillIds)
  });

  const runId = makeRunId("agent");
  const selectedSkills = resolveSkillsForRun(config, selectedSkillIds);
  const runState = createRunState(
    config,
    runId,
    selectedSkills,
    loadAgentMemory(config)
  );
  const interactive = options.interactive !== false;

  acquireRunLock(config, runId);

  try {
    saveRunState(config, runState);
    syncRunArtifact(config, runState);
    await executeRun(config, runState, { interactive });
    return summarizeRun(runState);
  } finally {
    releaseRunLock(config, runId);
  }
}

export async function resumeWorkflow(runId, options = {}) {
  const config = loadConfig();
  ensureStateLayout(config);

  const runState = normalizeRunState(loadRunState(config, runId), loadAgentMemory(config));
  const interactive = options.interactive !== false;
  await startupSyncSkills(config, {
    fetchRemote: true,
    requiredSkillIds: collectConfiguredSkillIds(runState.workflow, runState.selected_skill_ids)
  });

  acquireRunLock(config, runId);

  try {
    await handlePendingInput(config, runState, interactive);
    if (runState.status === "blocked_waiting_for_input") {
      return summarizeRun(runState);
    }

    await executeRun(config, runState, { interactive });
    return summarizeRun(runState);
  } finally {
    releaseRunLock(config, runId);
  }
}

function createRunState(config, runId, selectedSkills, agentMemory) {
  return normalizeRunState({
    run_id: runId,
    workflow: deepClone(config.workflow),
    selected_skill_ids: selectedSkills.map((skill) => skill.id),
    skill_snapshots: selectedSkills.map((skill) => deepClone(skill)),
    status: "running",
    started_at: nowIso(),
    updated_at: nowIso(),
    finished_at: null,
    current_task_index: 0,
    blocked_task_index: null,
    pending_input_request_id: null,
    input_values: {},
    input_secret_refs: {},
    persisted_values: {},
    persisted_secret_refs: {},
    agent_memory_values: deepClone(agentMemory.values || {}),
    agent_memory_secret_refs: deepClone(agentMemory.secret_refs || {}),
    task_attempts: {},
    task_results: [],
    state_change_log: [],
    external_calls: [],
    task_operation_results: {},
    task_checkpoints: {},
    task_operation_meta: {},
    evaluation: null,
    error: null
  }, agentMemory);
}

function normalizeRunState(runState, agentMemory = { values: {}, secret_refs: {} }) {
  return {
    ...runState,
    input_values: runState.input_values || {},
    input_secret_refs: runState.input_secret_refs || {},
    persisted_values: runState.persisted_values || {},
    persisted_secret_refs: runState.persisted_secret_refs || {},
    agent_memory_values: deepClone({
      ...(runState.agent_memory_values || {}),
      ...(agentMemory.values || {})
    }),
    agent_memory_secret_refs: deepClone({
      ...(runState.agent_memory_secret_refs || {}),
      ...(agentMemory.secret_refs || {})
    }),
    task_attempts: runState.task_attempts || {},
    task_results: Array.isArray(runState.task_results) ? runState.task_results : [],
    state_change_log: Array.isArray(runState.state_change_log) ? runState.state_change_log : [],
    external_calls: Array.isArray(runState.external_calls) ? runState.external_calls : [],
    task_operation_results: runState.task_operation_results || {},
    task_checkpoints: runState.task_checkpoints || {},
    task_operation_meta: runState.task_operation_meta || {}
  };
}

async function executeRun(config, runState, { interactive }) {
  const artifactsDir = getRunArtifactsDir(config, runState.run_id);
  let sawPartial = runState.task_results.some((taskResult) => taskResult.status === "partial" || taskResult.status === "blocked");

  for (let taskIndex = runState.current_task_index; taskIndex < runState.workflow.tasks.length; taskIndex += 1) {
    const task = runState.workflow.tasks[taskIndex];
    let attempt = Number(runState.task_attempts?.[task.id] || 0) + 1;

    while (true) {
      runState.task_attempts[task.id] = attempt;
      if (attempt > MAX_OPERATION_ROUNDS_PER_TASK) {
        throw new Error(`Task ${task.id} exceeded the maximum of ${MAX_OPERATION_ROUNDS_PER_TASK} attempts while executing requested operations.`);
      }
      const selectedSkills = selectSkillsForTask(runState, task);
      const preflight = await runTaskPreflightChecks(task);
      if (!preflight.ok) {
        const blockedResponse = buildPreflightBlockedResponse(task, preflight);
        const mutatedResponse = applyStateChanges({
          config,
          runState,
          task,
          attempt,
          response: blockedResponse
        });
        const redactedResponse = redactTaskArtifacts(mutatedResponse.response, {
          redactions: mutatedResponse.redactions
        });
        persistTaskReceipts(runState, task, attempt, redactedResponse);
        const taskResult = {
          task_id: task.id,
          goal: task.goal,
          status: redactedResponse.status,
          execution: redactedResponse.execution,
          journal: redactedResponse.journal,
          output: redactedResponse.output,
          reasoning: redactedResponse.reasoning,
          state_changes: redactedResponse.state_changes,
          attempt,
          skill_ids: selectedSkills.map((skill) => skill.id)
        };

        runState.task_results.push(taskResult);
        runState.current_task_index = taskIndex + 1;
        runState.blocked_task_index = null;
        runState.pending_input_request_id = null;
        runState.status = "running";
        saveRunState(config, runState);
        syncRunArtifact(config, runState);

        writeJson(path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${task.id}`, "task-record.json"), taskResult);
        writeTaskSideEffectArtifacts(artifactsDir, taskIndex, task.id, redactedResponse);

        if (task.continue_on_blocked === true) {
          sawPartial = true;
          break;
        }

        runState.status = "blocked";
        runState.error = `Task blocked: ${task.id}`;
        return finalizeRun(config, runState);
      }

      const runtimeSecrets = resolveRuntimeSecrets(config, runState);
      const taskContext = buildTaskContext(config, runState, task, selectedSkills, runtimeSecrets);
      const priorTaskResults = runState.task_results.map((taskResult) => ({
        task_id: taskResult.task_id,
        status: taskResult.status,
        output: taskResult.output
      }));

      const execution = await runCodexTask({
        config,
        runId: runState.run_id,
        workflow: runState.workflow,
        task,
        taskIndex,
        taskContext,
        priorTaskResults,
        skillSnapshots: selectedSkills,
        artifactsDir,
        attempt,
        redactions: runtimeSecrets.redactions
      });

      if (!execution.parsed) {
        if (execution.abortedForExploration) {
          throw new Error(execution.abortReason || `Codex was aborted for excessive exploration during task ${task.id}.`);
        }
        if (execution.timedOut) {
          throw new Error(`Codex timed out while executing task ${task.id}.`);
        }
        throw new Error(`Codex did not return a structured response for task ${task.id}.`);
      }

      validateOrThrow(buildCodexTaskResponseSchema(task), execution.parsed, `Task ${task.id}`);
      runState.task_checkpoints[task.id] = normalizeTaskCheckpoint(execution.parsed.task_checkpoint);

      if (Array.isArray(execution.parsed.requested_operations) && execution.parsed.requested_operations.length > 0) {
        const operationSignature = safeJsonStringify(execution.parsed.requested_operations);
        const operationMeta = runState.task_operation_meta[task.id] || {
          last_signature: null,
          repeated_count: 0
        };
        const repeatedCount = operationMeta.last_signature === operationSignature
          ? operationMeta.repeated_count + 1
          : 1;
        runState.task_operation_meta[task.id] = {
          last_signature: operationSignature,
          repeated_count: repeatedCount
        };
        if (repeatedCount > MAX_REPEATED_OPERATION_BATCHES) {
          const blockedResponse = buildRepeatedOperationsBlockedResponse(task, execution.parsed.requested_operations, repeatedCount);
          const redactedBlockedResponse = redactTaskArtifacts(blockedResponse, {
            redactions: runtimeSecrets.redactions
          });
          persistTaskReceipts(runState, task, attempt, redactedBlockedResponse);
          const taskResult = {
            task_id: task.id,
            goal: task.goal,
            status: redactedBlockedResponse.status,
            execution: redactedBlockedResponse.execution,
            journal: redactedBlockedResponse.journal,
            output: redactedBlockedResponse.output,
            reasoning: redactedBlockedResponse.reasoning,
            state_changes: redactedBlockedResponse.state_changes,
            attempt,
            skill_ids: selectedSkills.map((skill) => skill.id)
          };
          runState.task_results.push(taskResult);
          runState.current_task_index = taskIndex + 1;
          runState.blocked_task_index = null;
          runState.pending_input_request_id = null;
          runState.status = task.continue_on_blocked === true ? "running" : "blocked";
          saveRunState(config, runState);
          syncRunArtifact(config, runState);
          writeJson(path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${task.id}`, "task-record.json"), taskResult);
          writeTaskSideEffectArtifacts(artifactsDir, taskIndex, task.id, redactedBlockedResponse);
          if (task.continue_on_blocked === true) {
            sawPartial = true;
            break;
          }
          runState.error = `Task blocked: ${task.id}`;
          return finalizeRun(config, runState);
        }
        const operationResults = await executeRequestedOperations({
          task,
          attempt,
          requestedOperations: execution.parsed.requested_operations
        });
        const taskOperationResults = Array.isArray(runState.task_operation_results[task.id])
          ? runState.task_operation_results[task.id]
          : [];
        runState.task_operation_results[task.id] = [...taskOperationResults, ...operationResults];
        persistOperationReceipts(runState, task, attempt, operationResults);
        writeJson(
          path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${task.id}`, `attempt-${attempt}-operation-results.json`),
          operationResults
        );
        saveRunState(config, runState);
        syncRunArtifact(config, runState);
        attempt += 1;
        continue;
      }

      if (execution.parsed.status === "blocked_waiting_for_input") {
        if (!execution.parsed.input_request) {
          throw new Error(`Task ${task.id} returned blocked_waiting_for_input without input_request.`);
        }

        const blockedResponse = applyStateChanges({
          config,
          runState,
          task,
          attempt,
          response: deepClone(execution.parsed)
        });
        const blockedRedactions = {
          redactions: [...runtimeSecrets.redactions, ...blockedResponse.redactions]
        };
        const redactedBlockedResponse = redactTaskArtifacts(blockedResponse.response, blockedRedactions);
        persistTaskReceipts(runState, task, attempt, redactedBlockedResponse);

        const inputRequest = createInputRequest({
          runId: runState.run_id,
          taskId: task.id,
          skillId: selectedSkills.length === 1 ? selectedSkills[0].id : null,
          request: execution.parsed.input_request
        });

        saveInputRequest(config, inputRequest);
        runState.pending_input_request_id = inputRequest.id;
        runState.blocked_task_index = taskIndex;
        runState.current_task_index = taskIndex;
        runState.status = "blocked_waiting_for_input";
        runState.evaluation = null;
        saveRunState(config, runState);
        syncRunArtifact(config, runState);

        writeJson(path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${task.id}`, "task-record.json"), {
          task_id: task.id,
          goal: task.goal,
          status: "blocked_waiting_for_input",
          input_request_id: inputRequest.id,
          response: redactedBlockedResponse
        });
        writeTaskSideEffectArtifacts(artifactsDir, taskIndex, task.id, redactedBlockedResponse);

        if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
          const answeredRequest = await answerInputRequestInteractive(config, inputRequest.id);
          if (!requestIsAnswered(answeredRequest)) {
            return finalizeRun(config, runState);
          }

          applyInputRequestAnswers(runState, answeredRequest);
          runState.pending_input_request_id = null;
          runState.blocked_task_index = null;
          runState.status = "running";
          saveRunState(config, runState);
          syncRunArtifact(config, runState);
          attempt += 1;
          continue;
        }

        return finalizeRun(config, runState);
      }

      const guardedResponse = applyTaskGuardrails({
        config,
        runState,
        task,
        response: deepClone(execution.parsed)
      });

      validateOrThrow(buildCodexTaskResponseSchema(task), guardedResponse, `Guarded task ${task.id}`);

      const mutatedResponse = applyStateChanges({
        config,
        runState,
        task,
        attempt,
        response: guardedResponse
      });
      const redactedResponse = redactTaskArtifacts(mutatedResponse.response, {
        redactions: [...runtimeSecrets.redactions, ...mutatedResponse.redactions]
      });
      persistTaskReceipts(runState, task, attempt, redactedResponse);
      const taskResult = {
        task_id: task.id,
        goal: task.goal,
        status: redactedResponse.status,
        execution: redactedResponse.execution,
        journal: redactedResponse.journal,
        output: redactedResponse.output,
        reasoning: redactedResponse.reasoning,
        state_changes: redactedResponse.state_changes,
        attempt,
        skill_ids: selectedSkills.map((skill) => skill.id)
      };

      runState.task_results.push(taskResult);
      runState.task_operation_meta[task.id] = {
        last_signature: null,
        repeated_count: 0
      };
      runState.current_task_index = taskIndex + 1;
      runState.blocked_task_index = null;
      runState.pending_input_request_id = null;
      runState.status = "running";
      saveRunState(config, runState);
      syncRunArtifact(config, runState);

      writeJson(path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${task.id}`, "task-record.json"), taskResult);
      writeTaskSideEffectArtifacts(artifactsDir, taskIndex, task.id, redactedResponse);

      if (taskResult.status === "failed") {
        runState.status = "failed";
        runState.error = `Task failed: ${task.id}`;
        return finalizeRun(config, runState);
      }

      if (taskResult.status === "blocked") {
        if (task.continue_on_blocked === true) {
          sawPartial = true;
          break;
        }

        runState.status = "blocked";
        runState.error = `Task blocked: ${task.id}`;
        return finalizeRun(config, runState);
      }

      if (taskResult.status === "partial") {
        sawPartial = true;
      }

      break;
    }
  }

  runState.status = sawPartial ? "partial" : "completed";
  return finalizeRun(config, runState);
}

async function runTaskPreflightChecks(task) {
  const checks = Array.isArray(task.preflight_checks) ? task.preflight_checks : [];
  for (const check of checks) {
    const result = await runPreflightCheck(check);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true };
}

async function runPreflightCheck(check) {
  if (check.kind !== "http") {
    return {
      ok: false,
      kind: check.kind,
      target: check.target,
      status: `unsupported preflight kind: ${check.kind}`,
      reason: `Unsupported preflight kind ${check.kind}.`
    };
  }

  const timeoutMs = Number.isInteger(check.timeout_ms) ? check.timeout_ms : 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(check.target, {
      method: check.method || "HEAD",
      signal: controller.signal,
      redirect: "follow"
    });
    clearTimeout(timeoutId);

    const expectedStatuses = Array.isArray(check.expected_status) && check.expected_status.length > 0
      ? check.expected_status
      : null;
    const inconclusiveStatuses = Array.isArray(check.inconclusive_status) && check.inconclusive_status.length > 0
      ? check.inconclusive_status
      : [];
    const statusMatches = expectedStatuses ? expectedStatuses.includes(response.status) : response.ok;
    if (!statusMatches && inconclusiveStatuses.includes(response.status)) {
      return {
        ok: true,
        inconclusive: true,
        kind: check.kind,
        target: check.target,
        status: `preflight returned HTTP ${response.status} and was treated as inconclusive`
      };
    }
    if (!statusMatches) {
      return {
        ok: false,
        kind: check.kind,
        target: check.target,
        status: `preflight returned HTTP ${response.status}`,
        reason: `Preflight check for ${check.target} returned HTTP ${response.status}.`
      };
    }

    return {
      ok: true,
      kind: check.kind,
      target: check.target,
      status: `preflight returned HTTP ${response.status}`
    };
  } catch (error) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      kind: check.kind,
      target: check.target,
      status: `preflight failed: ${error.message}`,
      reason: `Preflight check for ${check.target} failed: ${error.message}`
    };
  }
}

async function handlePendingInput(config, runState, interactive) {
  if (!runState.pending_input_request_id) {
    return;
  }

  let request = loadInputRequest(config, runState.pending_input_request_id);
  if (request.status === "open" && interactive && process.stdin.isTTY && process.stdout.isTTY) {
    request = await answerInputRequestInteractive(config, request.id);
  }

  if (!requestIsAnswered(request)) {
    runState.status = "blocked_waiting_for_input";
    saveRunState(config, runState);
    syncRunArtifact(config, runState);
    return;
  }

  applyInputRequestAnswers(runState, request);
  runState.pending_input_request_id = null;
  runState.blocked_task_index = null;
  runState.status = "running";
  saveRunState(config, runState);
  syncRunArtifact(config, runState);
}

async function finalizeRun(config, runState) {
  if (runState.task_results.length > 0) {
    try {
      runState.evaluation = await evaluateRun({
        config,
        runState: buildEvaluationInput(runState),
        artifactsDir: getRunArtifactsDir(config, runState.run_id)
      });
    } catch (error) {
      runState.evaluation = {
        status: runState.status,
        score: 0,
        summary: "Evaluation failed to run.",
        strengths: [],
        failures: [error.message],
        risks: [],
        recommended_changes: ["Inspect evaluation prompt and Codex authentication state."],
        one_line_assessment: "The workflow ran, but the evaluation step failed."
      };
    }
  }

  if (runState.status !== "blocked_waiting_for_input") {
    runState.finished_at = nowIso();
  }

  saveRunState(config, runState);
  syncRunArtifact(config, runState);
  return runState;
}

function buildTaskContext(config, runState, task, selectedSkills, runtimeSecrets) {
  const allOperationResults = runState.task_operation_results[task.id] || [];
  let operationResults;
  if (allOperationResults.length > 5) {
    const olderResults = allOperationResults.slice(0, -5).map((result) => ({
      id: result.id,
      ok: result.ok,
      status: result.status,
      target: result.target
    }));
    operationResults = [...olderResults, ...allOperationResults.slice(-5)];
  } else {
    operationResults = allOperationResults;
  }
  return {
    workflow: {
      id: runState.workflow.id,
      name: runState.workflow.name
    },
    global: config.agentContext,
    inputs: runState.input_values,
    memory: {
      run: runState.persisted_values,
      agent: runState.agent_memory_values
    },
    secrets: runtimeSecrets.secrets,
    task_specific: task.context,
    task_controls: {
      continue_on_blocked: task.continue_on_blocked === true
    },
    operation_results: operationResults,
    task_checkpoint: runState.task_checkpoints[task.id] || { entries: [] },
    selected_skills: selectedSkills.map((skill) => ({
      id: skill.id,
      title: skill.title
    })),
    transaction_guardrails: isTransactionTask(task) ? buildTransactionGuardrailContext(config, runState) : null,
    prior_outputs: runState.task_results.map((taskResult) => ({
      task_id: taskResult.task_id,
      status: taskResult.status
    }))
  };
}

async function executeRequestedOperations({ task, attempt, requestedOperations }) {
  const results = [];

  for (const operation of requestedOperations) {
    if (operation.kind !== "http_request") {
      results.push({
        id: operation.id,
        kind: operation.kind,
        purpose: operation.purpose,
        ok: false,
        status: 0,
        error: `Unsupported requested operation kind: ${operation.kind}`,
        target: operation.url || ""
      });
      continue;
    }

    results.push(await executeHttpRequestOperation(task, attempt, operation));
  }

  return results;
}

async function executeHttpRequestOperation(task, attempt, operation) {
  const headers = Object.fromEntries((operation.headers || []).map((header) => [header.name, header.value]));
  const fetchOptions = {
    method: operation.method,
    headers,
    redirect: "follow"
  };

  if (operation.body_format !== "none") {
    fetchOptions.body = operation.body;
  }

  try {
    const response = await fetch(operation.url, fetchOptions);
    const responseText = await response.text();
    return {
      id: operation.id,
      kind: operation.kind,
      purpose: operation.purpose,
      ok: response.ok,
      status: response.status,
      target: operation.url,
      request: {
        method: operation.method,
        headers: operation.headers || [],
        body_format: operation.body_format
      },
      response: {
        headers: Object.fromEntries(response.headers.entries()),
        body_text: responseText,
        body_json: tryParseJson(responseText)
      }
    };
  } catch (error) {
    return {
      id: operation.id,
      kind: operation.kind,
      purpose: operation.purpose,
      ok: false,
      status: 0,
      target: operation.url,
      request: {
        method: operation.method,
        headers: operation.headers || [],
        body_format: operation.body_format
      },
      error: error.message
    };
  }
}

function selectSkillsForTask(runState, task) {
  const skillIds = task.skill_ids.length > 0
    ? task.skill_ids
    : task.use_default_skills === false
      ? []
      : runState.selected_skill_ids;
  return runState.skill_snapshots.filter((skill) => skillIds.includes(skill.id));
}

function buildEvaluationInput(runState) {
  return {
    run_id: runState.run_id,
    workflow: {
      id: runState.workflow.id,
      name: runState.workflow.name
    },
    selected_skill_ids: runState.selected_skill_ids,
    task_results: runState.task_results.map((result) => ({
      task_id: result.task_id,
      goal: result.goal,
      status: result.status,
      reasoning: result.reasoning,
      output: result.output,
      attempt: result.attempt
    })),
    state_change_log: runState.state_change_log,
    external_calls: runState.external_calls,
    status: runState.status,
    blocked_task_index: runState.blocked_task_index,
    pending_input_request_id: runState.pending_input_request_id,
    error: runState.error
  };
}

function buildPreflightBlockedResponse(task, preflight) {
  const summary = `The task is blocked before execution because a configured preflight check failed for ${preflight.target}.`;
  const note = preflight.reason || summary;
  return {
    status: "blocked",
    execution: {
      summary,
      actions_taken: [
        {
          type: "preflight_check_failed",
          summary: note
        }
      ],
      external_calls: [
        {
          kind: `Preflight ${String(preflight.kind || "check").toUpperCase()}`,
          target: preflight.target || "",
          status: preflight.status || "preflight failed"
        }
      ],
      artifacts_created: []
    },
    journal: {
      summary: note,
      events: [
        {
          kind: "warning",
          message: "Task execution was blocked by a failed preflight check.",
          timestamp: nowIso(),
          data: note
        }
      ],
      conclusions: [
        "The task could not safely start because a required dependency check failed."
      ]
    },
    output: buildPlaceholderValue(task.outputSchema),
    reasoning: "A configured preflight dependency check failed before task execution could begin.",
    input_request: {
      prompt: "",
      fields: []
    },
    state_changes: [],
    requested_operations: [],
    task_checkpoint: { entries: [] }
  };
}

function buildRepeatedOperationsBlockedResponse(task, requestedOperations, repeatedCount) {
  const summary = `The task is blocked because it requested the same operation batch ${repeatedCount} times without converging.`;
  const operationTargets = requestedOperations.map((operation) => `${operation.method} ${operation.url}`).join(", ");
  return {
    status: "blocked",
    execution: {
      summary,
      actions_taken: [
        {
          type: "repeated_requested_operations",
          summary: `Repeated the same requested_operations batch ${repeatedCount} times: ${operationTargets}`
        }
      ],
      external_calls: requestedOperations.map((operation) => ({
        kind: `Repeated ${operation.kind}`,
        target: operation.url,
        status: `repeated_${repeatedCount}_times_without_progress`
      })),
      artifacts_created: []
    },
    journal: {
      summary,
      events: [
        {
          kind: "warning",
          message: "The task kept requesting the same operation batch without making progress.",
          timestamp: nowIso(),
          data: operationTargets
        }
      ],
      conclusions: [
        "The task needs either a different next operation or an explicit terminal outcome."
      ]
    },
    output: buildPlaceholderValue(task.outputSchema),
    reasoning: "The task repeated the same harness-executed operation batch without converging on a new state.",
    input_request: {
      prompt: "",
      fields: []
    },
    state_changes: [],
    requested_operations: [],
    task_checkpoint: { entries: [] }
  };
}

export function summarizeRun(runState) {
  return {
    runId: runState.run_id,
    runStatus: runState.status,
    warnings: [],
    pendingInputRequestId: runState.pending_input_request_id,
    startedAt: runState.started_at,
    finishedAt: runState.finished_at,
    tasks: runState.task_results,
    externalCalls: runState.external_calls,
    evaluation: runState.evaluation
  };
}

export function printRunSummary(result) {
  return `${safeJsonStringify(result)}\n`;
}

function applyStateChanges({ config, runState, task, attempt, response }) {
  const redactions = [];
  const nextResponse = deepClone(response);
  const agentMemory = {
    values: deepClone(runState.agent_memory_values || {}),
    secret_refs: deepClone(runState.agent_memory_secret_refs || {})
  };
  let agentMemoryChanged = false;

  if (!Array.isArray(nextResponse.state_changes) || nextResponse.state_changes.length === 0) {
    return { response: nextResponse, redactions };
  }

  const shouldPersist = nextResponse.status !== "failed";

  nextResponse.state_changes = nextResponse.state_changes.map((change) => {
    const nextChange = { ...change, secret_ref: change.secret_ref ?? null };
    if (!shouldPersist) {
      if (nextChange.sensitivity === "secret") {
        redactions.push(...collectRedactableStrings(parseStateChangeValue(task, nextChange)));
        return {
          ...nextChange,
          value: "[REDACTED]",
          secret_ref: null
        };
      }

      return nextChange;
    }

    const parsedValue = parseStateChangeValue(task, nextChange);
    if (nextChange.sensitivity === "secret") {
      redactions.push(...collectRedactableStrings(parsedValue));
      const secretRef = storeStateChangeSecret(config, {
        runId: runState.run_id,
        taskId: task.id,
        change: nextChange,
        value: parsedValue
      });

      if (nextChange.scope === "agent") {
        setNestedValue(agentMemory.secret_refs, nextChange.key, secretRef);
        agentMemoryChanged = true;
      } else {
        setNestedValue(runState.persisted_secret_refs, nextChange.key, secretRef);
      }

      return {
        ...nextChange,
        value: "[REDACTED]",
        secret_ref: secretRef
      };
    }

    if (nextChange.scope === "agent") {
      setNestedValue(agentMemory.values, nextChange.key, parsedValue);
      agentMemoryChanged = true;
    } else {
      setNestedValue(runState.persisted_values, nextChange.key, parsedValue);
    }

    return {
      ...nextChange,
      secret_ref: null
    };
  });

  if (shouldPersist) {
    runState.agent_memory_values = agentMemory.values;
    runState.agent_memory_secret_refs = agentMemory.secret_refs;
    if (agentMemoryChanged) {
      saveAgentMemory(config, agentMemory);
    }
  }

  return { response: nextResponse, redactions };
}

function persistTaskReceipts(runState, task, attempt, response) {
  const recordedAt = nowIso();

  if (Array.isArray(response.execution?.external_calls) && response.execution.external_calls.length > 0) {
    runState.external_calls.push(...response.execution.external_calls.map((call) => ({
      ...call,
      task_id: task.id,
      attempt,
      recorded_at: recordedAt
    })));
  }

  if (Array.isArray(response.state_changes) && response.state_changes.length > 0) {
    runState.state_change_log.push(...response.state_changes.map((change) => ({
      ...change,
      task_id: task.id,
      attempt,
      recorded_at: recordedAt
    })));
  }
}

function persistOperationReceipts(runState, task, attempt, operationResults) {
  const recordedAt = nowIso();
  runState.external_calls.push(...operationResults.map((result) => ({
    kind: result.kind === "http_request" ? `Requested HTTP ${result.request?.method || ""}`.trim() : result.kind,
    target: result.target || "",
    status: result.ok ? `HTTP ${result.status}` : result.error || `HTTP ${result.status}`,
    task_id: task.id,
    attempt,
    recorded_at: recordedAt
  })));
}

function writeTaskSideEffectArtifacts(artifactsDir, taskIndex, taskId, response) {
  const taskDir = path.join(artifactsDir, "tasks", `${String(taskIndex + 1).padStart(2, "0")}-${taskId}`);
  writeJson(path.join(taskDir, "external-calls.json"), response.execution?.external_calls || []);
  writeJson(path.join(taskDir, "state-changes.json"), response.state_changes || []);
}

function isTransactionTask(task) {
  return /transaction/i.test(task.id) || /make transactions/i.test(task.goal);
}

function buildTransactionGuardrailContext(config, runState) {
  return {
    ...deepClone(config.transactionGuardrails),
    approval: {
      required: config.transactionGuardrails.requireHumanApproval,
      granted: hasTransactionApproval(config, runState),
      approval_path: "transaction_approval.approved",
      approval_notes_path: "transaction_approval.notes"
    }
  };
}

function hasTransactionApproval(config, runState) {
  const inputApproval = getNestedValue(runState.input_values, "transaction_approval.approved");
  if (typeof inputApproval === "boolean") {
    return inputApproval;
  }

  const configuredApproval = getNestedValue(config.agentContext, "transaction_approval.approved");
  return configuredApproval === true;
}

function applyTaskGuardrails({ config, runState, task, response }) {
  if (!isTransactionTask(task)) {
    return response;
  }

  const guardrails = buildTransactionGuardrailContext(config, runState);
  const violations = collectTransactionGuardrailViolations(response, guardrails);

  if (violations.length === 0) {
    return response;
  }

  const note = `Transaction guardrails blocked the task: ${violations.join(" | ")}`;
  return {
    ...response,
    status: "failed",
    execution: {
      ...response.execution,
      summary: joinSentences(response.execution.summary, note),
      actions_taken: [
        ...response.execution.actions_taken,
        {
          type: "guardrail_violation",
          summary: note
        }
      ]
    },
    journal: {
      ...response.journal,
      summary: joinSentences(response.journal.summary, "Transaction guardrails rejected the proposed execution output."),
      events: [
        ...response.journal.events,
        ...violations.map((message) => ({
          kind: "warning",
          message,
          timestamp: nowIso(),
          data: "transaction_guardrails"
        }))
      ],
      conclusions: [
        ...response.journal.conclusions,
        "The execution output violated transaction guardrails and was rejected."
      ]
    },
    output: appendGuardrailNotesToOutput(response.output, violations, note),
    reasoning: "Transaction guardrails rejected the proposed actions because they violated execution policy."
  };
}

function collectTransactionGuardrailViolations(response, guardrails) {
  const violations = [];
  const actions = Array.isArray(response.output?.actions) ? response.output.actions : [];
  const liveStatuses = new Set(guardrails.liveStatuses.map(normalizePolicyToken));
  const allowedAssets = new Set(guardrails.allowedAssets.map(normalizePolicyToken));
  const blockedAssets = new Set(guardrails.blockedAssets.map(normalizePolicyToken));
  const allowedActionTypes = new Set(guardrails.allowedActionTypes.map(normalizePolicyToken));
  const blockedActionTypes = new Set(guardrails.blockedActionTypes.map(normalizePolicyToken));

  if (!Array.isArray(response.output?.safeguards) || response.output.safeguards.length === 0) {
    violations.push("At least one safeguard must be reported for transaction tasks.");
  }

  if (actions.length > guardrails.maxActions) {
    violations.push(`Proposed ${actions.length} actions, exceeding the limit of ${guardrails.maxActions}.`);
  }

  for (const action of actions) {
    const actionType = normalizePolicyToken(action.type);
    const asset = normalizePolicyToken(action.asset);
    const status = normalizePolicyToken(action.status);
    const hasTxHash = typeof action.tx_hash === "string" && action.tx_hash.trim().length > 0;
    const isLiveAction = liveStatuses.has(status) || hasTxHash;

    if (allowedActionTypes.size > 0 && actionType && !allowedActionTypes.has(actionType)) {
      violations.push(`Action type ${action.type} is not allowed by policy.`);
    }

    if (blockedActionTypes.has(actionType)) {
      violations.push(`Action type ${action.type} is explicitly blocked by policy.`);
    }

    if (asset && allowedAssets.size > 0 && !allowedAssets.has(asset)) {
      violations.push(`Asset ${action.asset} is outside the allowlist.`);
    }

    if (asset && blockedAssets.has(asset)) {
      violations.push(`Asset ${action.asset} is blocked by policy.`);
    }

    if (guardrails.maxAmountPerAction !== null && Number.isFinite(action.amount) && action.amount > guardrails.maxAmountPerAction) {
      violations.push(`Action amount ${action.amount} exceeds the per-action limit of ${guardrails.maxAmountPerAction}.`);
    }

    if (guardrails.mode !== "live" && isLiveAction) {
      violations.push(`Live transaction status ${action.status} is not allowed while execution mode is ${guardrails.mode}.`);
    }

    if (isLiveAction && guardrails.approval.required && !guardrails.approval.granted) {
      violations.push(`Live action ${action.type} requires explicit human approval before execution.`);
    }

    if (liveStatuses.has(status) && !hasTxHash) {
      violations.push(`Action ${action.type} reported live status ${action.status} without a transaction hash.`);
    }
  }

  return [...new Set(violations)];
}

function normalizePolicyToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function joinSentences(...parts) {
  return parts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .trim();
}

function appendGuardrailNotesToOutput(output, violations, note) {
  const nextOutput = { ...output };

  if (Array.isArray(output?.safeguards)) {
    nextOutput.safeguards = [...output.safeguards, ...violations];
  }

  if (Array.isArray(output?.notes)) {
    nextOutput.notes = [...output.notes, note];
  }

  return nextOutput;
}

function collectConfiguredSkillIds(workflow, additionalSkillIds = []) {
  const workflowTaskSkillIds = workflow.tasks.flatMap((task) => task.skill_ids || []);
  return [...new Set([
    ...(workflow.default_skill_ids || []),
    ...workflowTaskSkillIds,
    ...(additionalSkillIds || [])
  ])];
}

function tryParseJson(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTaskCheckpoint(taskCheckpoint) {
  if (!taskCheckpoint || typeof taskCheckpoint !== "object" || !Array.isArray(taskCheckpoint.entries)) {
    return { entries: [] };
  }

  return {
    entries: taskCheckpoint.entries
      .filter((entry) => entry && typeof entry.key === "string" && typeof entry.value_json === "string")
      .map((entry) => ({
        key: entry.key,
        value_json: entry.value_json
      }))
  };
}

function buildPlaceholderValue(schema) {
  if (!schema || typeof schema !== "object") {
    return {};
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const nullableOption = schema.oneOf.find((option) => option?.type === "null");
    return nullableOption ? null : buildPlaceholderValue(schema.oneOf[0]);
  }

  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [key, buildPlaceholderValue(value)])
    );
  }

  if (schema.type === "array") {
    return [];
  }

  if (schema.type === "number" || schema.type === "integer") {
    return 0;
  }

  if (schema.type === "boolean") {
    return false;
  }

  if (schema.type === "null") {
    return null;
  }

  return "";
}

function resolveSelectedSkillIds(config) {
  return config.workflow.default_skill_ids.length > 0
    ? config.workflow.default_skill_ids
    : config.defaultSkillIds;
}

function parseStateChangeValue(task, change) {
  if (change.format === "json") {
    try {
      return JSON.parse(change.value);
    } catch (error) {
      throw new Error(`Task ${task.id} returned invalid JSON for state_changes key ${change.key}: ${error.message}`);
    }
  }

  return change.value;
}

function storeStateChangeSecret(config, { runId, taskId, change, value }) {
  return storeSecretValue(config, {
    value,
    key: change.key,
    label: change.summary,
    runId,
    taskId
  });
}

function collectRedactableStrings(value) {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRedactableStrings(item));
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((nestedValue) => collectRedactableStrings(nestedValue));
  }

  return [];
}
