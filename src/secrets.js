import path from "node:path";
import { secretReferenceSchema } from "./schemas.js";
import { validateOrThrow } from "./validation.js";
import { makeId, nowIso, readJson, redactText, redactValue, setNestedValue, writeJson } from "./utils.js";

export function resolveRuntimeSecrets(config, runState) {
  const envSecrets = {};
  const inputSecrets = {};
  const runSecrets = {};
  const agentSecrets = {};
  const redactions = [];

  for (const descriptor of config.secretDescriptors) {
    const value = process.env[descriptor.ref];
    if (!value && descriptor.required) {
      throw new Error(`Required secret env var is missing: ${descriptor.ref}`);
    }

    if (value) {
      envSecrets[descriptor.ref] = value;
      collectSecretRedactions(value, redactions);
    }
  }

  resolveSecretRefTree(config, runState.input_secret_refs || {}, inputSecrets, redactions);
  resolveSecretRefTree(config, runState.persisted_secret_refs || {}, runSecrets, redactions);
  resolveSecretRefTree(config, runState.agent_memory_secret_refs || {}, agentSecrets, redactions);

  return {
    secrets: {
      env: envSecrets,
      input: inputSecrets,
      run: runSecrets,
      agent: agentSecrets
    },
    redactions
  };
}

export function storeSecretValue(config, { value, key, label, runId, taskId }) {
  const base = [runId, taskId, key].filter(Boolean).join("-");
  const id = `${slugLike(base)}-${makeId("secret")}`;
  writeJson(path.join(config.stateDir, "secrets", `${id}.json`), {
    id,
    key,
    label,
    value,
    created_at: nowIso(),
    updated_at: nowIso()
  });

  return validateOrThrow(secretReferenceSchema, { id, kind: "state_secret", ref: id }, `Secret reference ${id}`);
}

export function redactTaskText(text, runtimeSecrets) {
  return redactText(text, runtimeSecrets.redactions);
}

export function redactTaskArtifacts(payload, runtimeSecrets) {
  return redactValue(payload, runtimeSecrets.redactions);
}

function walkSecretRefs(value, prefix, visitor) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (typeof value.id === "string" && typeof value.kind === "string" && typeof value.ref === "string") {
    visitor(prefix, value);
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    walkSecretRefs(nestedValue, nextPrefix, visitor);
  }
}

function resolveSecretRefTree(config, refs, target, redactions) {
  walkSecretRefs(refs, "", (dotPath, secretRef) => {
    const record = readJson(path.join(config.stateDir, "secrets", `${secretRef.ref}.json`));
    setNestedValue(target, dotPath, record.value);
    collectSecretRedactions(record.value, redactions);
  });
}

function collectSecretRedactions(value, redactions) {
  if (typeof value === "string" && value.trim().length > 0) {
    redactions.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSecretRedactions(item, redactions);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nestedValue of Object.values(value)) {
      collectSecretRedactions(nestedValue, redactions);
    }
  }
}

function slugLike(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
