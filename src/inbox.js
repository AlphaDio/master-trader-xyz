import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { persistedInputRequestSchema } from "./schemas.js";
import { storeSecretValue } from "./secrets.js";
import { validateOrThrow } from "./validation.js";
import { makeId, nowIso, pathExists, readJson, readText, setNestedValue, writeJson } from "./utils.js";

export function createInputRequest({ runId, taskId, skillId, request }) {
  const stored = {
    id: makeId("req"),
    run_id: runId,
    task_id: taskId,
    skill_id: skillId,
    status: "open",
    prompt: request.prompt,
    fields: request.fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      secret: field.secret,
      hint: field.hint,
      value: null,
      secret_ref: null
    })),
    created_at: nowIso(),
    answered_at: null
  };

  return validateOrThrow(persistedInputRequestSchema, stored, `Input request ${stored.id}`);
}

export function saveInputRequest(config, request) {
  validateOrThrow(persistedInputRequestSchema, request, `Input request ${request.id}`);
  writeJson(path.join(config.stateDir, "inbox", `${request.id}.json`), request);
}

export function loadInputRequest(config, requestId) {
  const filePath = path.join(config.stateDir, "inbox", `${requestId}.json`);
  if (!pathExists(filePath)) {
    throw new Error(`Input request not found: ${requestId}`);
  }

  return validateOrThrow(persistedInputRequestSchema, readJson(filePath), `Input request ${requestId}`);
}

export function listInputRequests(config) {
  const inboxDir = path.join(config.stateDir, "inbox");
  if (!pathExists(inboxDir)) {
    return [];
  }

  return fs
    .readdirSync(inboxDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readJson(path.join(inboxDir, fileName)))
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function answerInputRequestInteractive(config, requestId) {
  const request = loadInputRequest(config, requestId);
  const answered = await promptForRequest(config, request);
  saveInputRequest(config, answered);
  return answered;
}

export function importInputRequestAnswers(config, filePath) {
  const imported = JSON.parse(readText(path.resolve(filePath)));
  const existing = loadInputRequest(config, imported.id);
  const merged = mergeImportedAnswers(config, existing, imported);
  saveInputRequest(config, merged);
  return merged;
}

export function applyPostedInputRequestAnswers(config, requestId, answersByKey) {
  const request = loadInputRequest(config, requestId);
  const merged = mergePostedAnswers(config, request, answersByKey || {});
  saveInputRequest(config, merged);
  return merged;
}

export function applyInputRequestAnswers(runState, request) {
  for (const field of request.fields) {
    if (field.secret) {
      if (field.secret_ref) {
        setNestedValue(runState.input_secret_refs, field.key, field.secret_ref);
      }
      continue;
    }

    if (field.value !== null && field.value !== undefined && `${field.value}`.trim() !== "") {
      setNestedValue(runState.input_values, field.key, normalizeInputFieldValue(field.value));
    }
  }

  return runState;
}

export function requestIsAnswered(request) {
  return request.fields.every((field) => {
    if (!field.required) {
      return true;
    }

    if (field.secret) {
      return field.secret_ref !== null;
    }

    return field.value !== null && field.value !== undefined && `${field.value}`.trim() !== "";
  });
}

async function promptForRequest(config, request) {
  const rl = readline.createInterface({ input, output });

  try {
    for (const field of request.fields) {
      if (field.secret ? field.secret_ref : field.value) {
        continue;
      }

      const answer = await askForField(rl, field);
      if (field.secret) {
        field.secret_ref = storeSecretValue(config, {
          value: answer,
          key: field.key,
          label: field.label,
          runId: request.run_id,
          taskId: request.task_id
        });
        field.value = null;
      } else {
        field.value = answer;
      }
    }
  } finally {
    rl.close();
  }

  if (requestIsAnswered(request)) {
    request.status = "answered";
    request.answered_at = nowIso();
  }

  return request;
}

async function askForField(rl, field) {
  while (true) {
    const suffix = field.required ? " (required)" : "";
    const hint = field.hint ? ` - ${field.hint}` : "";
    const answer = (await rl.question(`${field.label}${suffix}${hint}: `)).trim();

    if (!field.required || answer.length > 0) {
      return answer;
    }
  }
}

function mergeImportedAnswers(config, existing, imported) {
  const merged = {
    ...existing,
    status: imported.status || existing.status,
    prompt: imported.prompt || existing.prompt,
    fields: existing.fields.map((field) => {
      const importedField = imported.fields?.find((candidate) => candidate.key === field.key) || {};
      const nextField = {
        ...field,
        value: importedField.value ?? field.value,
        secret_ref: importedField.secret_ref ?? field.secret_ref
      };

      if (field.secret && typeof importedField.value === "string" && importedField.value.length > 0) {
        nextField.secret_ref = storeSecretValue(config, {
          value: importedField.value,
          key: field.key,
          label: field.label,
          runId: existing.run_id,
          taskId: existing.task_id
        });
        nextField.value = null;
      }

      return nextField;
    }),
    answered_at: imported.answered_at ?? existing.answered_at
  };

  if (requestIsAnswered(merged)) {
    merged.status = "answered";
    merged.answered_at = merged.answered_at || nowIso();
  }

  return validateOrThrow(persistedInputRequestSchema, merged, `Input request ${merged.id}`);
}

function mergePostedAnswers(config, existing, answersByKey) {
  const merged = {
    ...existing,
    fields: existing.fields.map((field) => {
      if (!Object.prototype.hasOwnProperty.call(answersByKey, field.key)) {
        return field;
      }

      const rawValue = answersByKey[field.key];
      if (field.secret) {
        if (typeof rawValue !== "string" || rawValue.length === 0) {
          return field;
        }

        return {
          ...field,
          value: null,
          secret_ref: storeSecretValue(config, {
            value: rawValue,
            key: field.key,
            label: field.label,
            runId: existing.run_id,
            taskId: existing.task_id
          })
        };
      }

      return {
        ...field,
        value: rawValue
      };
    }),
    answered_at: existing.answered_at
  };

  if (requestIsAnswered(merged)) {
    merged.status = "answered";
    merged.answered_at = merged.answered_at || nowIso();
  }

  return validateOrThrow(persistedInputRequestSchema, merged, `Input request ${merged.id}`);
}

function normalizeInputFieldValue(value) {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  if (/^(true|false)$/i.test(normalized)) {
    return normalized.toLowerCase() === "true";
  }

  return value;
}
