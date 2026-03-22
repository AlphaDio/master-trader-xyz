import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBooleanEnv, readJsonEnv, readListEnv, readNumberEnv, slugify } from "./utils.js";
import { workflowSchema } from "./schemas.js";
import { validateOrThrow } from "./validation.js";
import { defaultWorkflow } from "./workflows.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const defaultAgentContext = {
  chain: "Base",
  portfolioName: "Main Portfolio",
  preferredDexes: ["Uniswap"],
  agentProfile: {
    name: "Master Trader XYZ",
    description: "A Codex-driven agent that researches markets, coordinates with its human, and proposes guarded execution plans.",
    image: "",
    agentHarness: "codex-cli",
    model: "gpt-5.4-mini"
  }
};
const defaultSkillUrls = ["https://synthesis.devfolio.co/skill.md"];
const defaultSkillIds = ["synthesis"];

export function loadConfig() {
  const workflow = validateOrThrow(
    workflowSchema,
    readJsonEnv("WORKFLOW_CONFIG_JSON", defaultWorkflow),
    "Workflow config"
  );
  const configuredSkillUrls = readListEnv("SKILL_URLS");
  const configuredDefaultSkillIds = readListEnv("DEFAULT_SKILL_IDS");

  const transactionGuardrails = {
    mode: process.env.TRANSACTION_EXECUTION_MODE || "dry-run",
    requireHumanApproval: readBooleanEnv("TRANSACTION_REQUIRE_HUMAN_APPROVAL", true),
    maxActions: readNumberEnv("TRANSACTION_MAX_ACTIONS", 3),
    maxAmountPerAction: readNumberEnv("TRANSACTION_MAX_AMOUNT_PER_ACTION", null),
    allowedAssets: readListEnv("TRANSACTION_ALLOWED_ASSETS"),
    blockedAssets: readListEnv("TRANSACTION_BLOCKED_ASSETS"),
    allowedActionTypes: readListEnv("TRANSACTION_ALLOWED_ACTION_TYPES"),
    blockedActionTypes: readListEnv("TRANSACTION_BLOCKED_ACTION_TYPES"),
    liveStatuses: readListEnv("TRANSACTION_LIVE_STATUSES")
  };

  if (!["dry-run", "live"].includes(transactionGuardrails.mode)) {
    throw new Error("TRANSACTION_EXECUTION_MODE must be either dry-run or live.");
  }

  if (!Number.isInteger(transactionGuardrails.maxActions) || transactionGuardrails.maxActions < 0) {
    throw new Error("TRANSACTION_MAX_ACTIONS must be a non-negative integer.");
  }

  const codexTaskTimeoutMs = readNumberEnv("CODEX_TASK_TIMEOUT_MS", 300000);
  if (!Number.isInteger(codexTaskTimeoutMs) || codexTaskTimeoutMs <= 0) {
    throw new Error("CODEX_TASK_TIMEOUT_MS must be a positive integer.");
  }

  return {
    projectRoot,
    stateDir: path.join(projectRoot, "state"),
    artifactsDir: path.join(projectRoot, "artifacts"),
    workflow,
    skillUrls: configuredSkillUrls.length > 0 ? configuredSkillUrls : defaultSkillUrls,
    defaultSkillIds: configuredDefaultSkillIds.length > 0 ? configuredDefaultSkillIds : defaultSkillIds,
    skillTargets: normalizeSkillTargets(
      readJsonEnv("SKILL_TARGETS_JSON", buildDefaultSkillTargets())
    ),
    agentContext: readJsonEnv("AGENT_CONTEXT_JSON", defaultAgentContext),
    secretDescriptors: readListEnv("AGENT_SECRET_KEYS").map((key) => ({
      id: slugify(key),
      kind: "env",
      ref: key,
      required: true,
      scope: "execution"
    })),
    transactionGuardrails: {
      ...transactionGuardrails,
      blockedActionTypes: transactionGuardrails.blockedActionTypes.length > 0
        ? transactionGuardrails.blockedActionTypes
        : ["approve_unlimited", "bridge", "deploy_contract"],
      liveStatuses: transactionGuardrails.liveStatuses.length > 0
        ? transactionGuardrails.liveStatuses
        : ["submitted", "broadcasted", "signed", "sent", "executed", "confirmed", "mined"]
    },
    codex: {
      bin: process.env.CODEX_BIN || (process.platform === "win32" ? "codex.cmd" : "codex"),
      model: process.env.CODEX_MODEL || null,
      workdir: path.resolve(projectRoot, process.env.CODEX_WORKDIR || "."),
      enableWebSearch: (process.env.CODEX_ENABLE_WEB_SEARCH || "true").toLowerCase() === "true",
      dangerousBypass: (process.env.CODEX_DANGEROUS_BYPASS || "false").toLowerCase() === "true",
      sandboxMode: process.env.CODEX_SANDBOX_MODE || "workspace-write",
      taskTimeoutMs: codexTaskTimeoutMs
    }
  };
}

function buildDefaultSkillTargets() {
  const homeDir = os.homedir();
  return [
    { tool: "codex", dir: path.join(homeDir, ".codex", "skills") },
    { tool: "claude", dir: path.join(homeDir, ".claude", "skills") },
    { tool: "cursor", dir: path.join(homeDir, ".cursor", "skills") },
    { tool: "github", dir: path.join(homeDir, ".github", "skills") },
    { tool: "opencode", dir: path.join(homeDir, ".opencode", "skills") }
  ];
}

function normalizeSkillTargets(targets) {
  if (!Array.isArray(targets)) {
    throw new Error("SKILL_TARGETS_JSON must be an array of { tool, dir } objects.");
  }

  return targets.map((target, index) => {
    if (!target || typeof target !== "object") {
      throw new Error(`SKILL_TARGETS_JSON entry at index ${index} must be an object.`);
    }

    if (typeof target.tool !== "string" || target.tool.trim().length === 0) {
      throw new Error(`SKILL_TARGETS_JSON entry at index ${index} is missing a valid tool name.`);
    }

    if (typeof target.dir !== "string" || target.dir.trim().length === 0) {
      throw new Error(`SKILL_TARGETS_JSON entry at index ${index} is missing a valid dir path.`);
    }

    return {
      tool: slugify(target.tool) || `tool-${index + 1}`,
      dir: path.resolve(target.dir)
    };
  });
}
