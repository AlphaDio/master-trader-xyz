import path from "node:path";
import { ensureDir, nowIso, tryReadJson, writeJson } from "./utils.js";

export function ensureStateLayout(config) {
  ensureDir(config.stateDir);
  ensureDir(path.join(config.stateDir, "skills"));
  ensureDir(path.join(config.stateDir, "inbox"));
  ensureDir(path.join(config.stateDir, "runs"));
  ensureDir(path.join(config.stateDir, "secrets"));
  ensureDir(config.artifactsDir);
}

export function loadAgentState(config) {
  return (
    tryReadJson(path.join(config.stateDir, "agent-state.json"), null) || {
      active_run_id: null,
      last_run_id: null,
      updated_at: nowIso()
    }
  );
}

export function loadAgentMemory(config) {
  return (
    tryReadJson(path.join(config.stateDir, "agent-memory.json"), null) || {
      values: {},
      secret_refs: {},
      updated_at: nowIso()
    }
  );
}

export function saveAgentState(config, state) {
  writeJson(path.join(config.stateDir, "agent-state.json"), {
    ...state,
    updated_at: nowIso()
  });
}

export function saveAgentMemory(config, memory) {
  writeJson(path.join(config.stateDir, "agent-memory.json"), {
    values: memory.values || {},
    secret_refs: memory.secret_refs || {},
    updated_at: nowIso()
  });
}

export function acquireRunLock(config, runId) {
  const state = loadAgentState(config);
  if (state.active_run_id && state.active_run_id !== runId) {
    throw new Error(`Another run is already active: ${state.active_run_id}`);
  }

  state.active_run_id = runId;
  state.last_run_id = runId;
  saveAgentState(config, state);
}

export function releaseRunLock(config, runId) {
  const state = loadAgentState(config);
  if (state.active_run_id === runId) {
    state.active_run_id = null;
    saveAgentState(config, state);
  }
}

export function getRunStatePath(config, runId) {
  return path.join(config.stateDir, "runs", `${runId}.json`);
}

export function loadRunState(config, runId) {
  const runState = tryReadJson(getRunStatePath(config, runId), null);
  if (!runState) {
    throw new Error(`Run state not found: ${runId}`);
  }

  return runState;
}

export function saveRunState(config, runState) {
  writeJson(getRunStatePath(config, runState.run_id), {
    ...runState,
    updated_at: nowIso()
  });
}

export function getRunArtifactsDir(config, runId) {
  return path.join(config.artifactsDir, runId);
}

export function syncRunArtifact(config, runState) {
  writeJson(path.join(getRunArtifactsDir(config, runState.run_id), "run.json"), runState);
}
