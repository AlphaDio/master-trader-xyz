import { loadConfig } from "./config.js";
import { answerInputRequestInteractive, importInputRequestAnswers, listInputRequests, loadInputRequest } from "./inbox.js";
import { printRunSummary, resumeWorkflow, runWorkflowOnce } from "./runner.js";
import {
  addSkillFromFile,
  addSkillFromUrl,
  checkSkillInstallations,
  deleteSkill,
  disableSkill,
  enableSkill,
  importSkillsFromTargets,
  integrateSkillToTargets,
  listSkills,
  listSkillTargets,
  loadSkill,
  refreshSkill,
  startupSyncSkills
} from "./skills.js";
import { ensureStateLayout } from "./state.js";
import { parseArgs, safeJsonStringify } from "./utils.js";

export async function runCli(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0] || "run-once";
  const config = loadConfig();
  ensureStateLayout(config);

  if (command === "skills") {
    await startupSyncSkills(config, {
      fetchRemote: false,
      requiredSkillIds: []
    });
  }

  switch (command) {
    case "run-once": {
      const result = await runWorkflowOnce({ interactive: flags["no-interactive"] !== true });
      writeWarnings(result.warnings);
      process.stdout.write(printRunSummary(result));
      return;
    }
    case "resume": {
      const runId = positionals[1];
      if (!runId) {
        throw new Error("Usage: resume <run-id>");
      }

      const result = await resumeWorkflow(runId, { interactive: flags["no-interactive"] !== true });
      writeWarnings(result.warnings);
      process.stdout.write(printRunSummary(result));
      return;
    }
    case "skills": {
      await handleSkillsCommand(config, positionals.slice(1), flags);
      return;
    }
    case "inbox": {
      await handleInboxCommand(config, positionals.slice(1), flags);
      return;
    }
    case "config": {
      if (positionals[1] !== "print") {
        throw new Error("Usage: config print");
      }

      process.stdout.write(`${safeJsonStringify({
        workflow: config.workflow,
        skillUrls: config.skillUrls,
        defaultSkillIds: config.defaultSkillIds,
        skillTargets: config.skillTargets,
        agentContext: config.agentContext,
        secretDescriptors: config.secretDescriptors,
        transactionGuardrails: config.transactionGuardrails,
        codex: {
          ...config.codex,
          bin: config.codex.bin
        }
      })}\n`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function handleSkillsCommand(config, positionals, flags) {
  const subcommand = positionals[0];
  const tools = normalizeFlagList(flags.tool);

  switch (subcommand) {
    case "add": {
      if (flags.url) {
        const skill = await addSkillFromUrl(config, flags.url, { name: flags.name });
        process.stdout.write(`${safeJsonStringify(skill)}\n`);
        return;
      }

      if (flags.file) {
        const skill = addSkillFromFile(config, flags.file, { name: flags.name });
        process.stdout.write(`${safeJsonStringify(skill)}\n`);
        return;
      }

      throw new Error("Usage: skills add --url <url> [--name <name>] | --file <path> [--name <name>]");
    }
    case "list":
      process.stdout.write(`${safeJsonStringify(listSkills(config))}\n`);
      return;
    case "check":
      process.stdout.write(`${safeJsonStringify({
        targets: listSkillTargets(config),
        installations: checkSkillInstallations(config, { tools })
      })}\n`);
      return;
    case "show": {
      const skillId = positionals[1];
      if (!skillId) {
        throw new Error("Usage: skills show <skill-id>");
      }

      process.stdout.write(`${safeJsonStringify(loadSkill(config, skillId))}\n`);
      return;
    }
    case "refresh": {
      const skillId = positionals[1];
      if (!skillId) {
        throw new Error("Usage: skills refresh <skill-id>");
      }

      process.stdout.write(`${safeJsonStringify(await refreshSkill(config, skillId))}\n`);
      return;
    }
    case "import":
      process.stdout.write(`${safeJsonStringify(importSkillsFromTargets(config, { tools }))}\n`);
      return;
    case "integrate": {
      const skillId = positionals[1];
      if (!skillId) {
        throw new Error("Usage: skills integrate <skill-id> [--tool <tool> ...] [--force] [--all-targets]");
      }

      process.stdout.write(`${safeJsonStringify(integrateSkillToTargets(config, skillId, {
        tools,
        force: flags.force === true,
        allTargets: flags["all-targets"] === true
      }))}\n`);
      return;
    }
    case "enable": {
      const skillId = positionals[1];
      if (!skillId) {
        throw new Error("Usage: skills enable <skill-id>");
      }

      process.stdout.write(`${safeJsonStringify(enableSkill(config, skillId))}\n`);
      return;
    }
    case "disable":
    case "remove": {
      const skillId = positionals[1];
      if (!skillId) {
        throw new Error(`Usage: skills ${subcommand} <skill-id>`);
      }

      process.stdout.write(`${safeJsonStringify(disableSkill(config, skillId))}\n`);
      return;
    }
    case "delete": {
      const skillId = positionals[1];
      if (!skillId) {
        throw new Error("Usage: skills delete <skill-id>");
      }

      deleteSkill(config, skillId);
      process.stdout.write(`${safeJsonStringify({ deleted: skillId })}\n`);
      return;
    }
    default:
      throw new Error("Usage: skills <add|list|check|show|refresh|import|integrate|enable|disable|remove|delete> ...");
  }
}

async function handleInboxCommand(config, positionals, flags) {
  const subcommand = positionals[0];

  switch (subcommand) {
    case "list":
      process.stdout.write(`${safeJsonStringify(listInputRequests(config))}\n`);
      return;
    case "show": {
      const requestId = positionals[1];
      if (!requestId) {
        throw new Error("Usage: inbox show <request-id>");
      }

      process.stdout.write(`${safeJsonStringify(loadInputRequest(config, requestId))}\n`);
      return;
    }
    case "answer": {
      const requestId = positionals[1];
      if (!requestId) {
        throw new Error("Usage: inbox answer <request-id>");
      }

      process.stdout.write(`${safeJsonStringify(await answerInputRequestInteractive(config, requestId))}\n`);
      return;
    }
    case "import": {
      const filePath = positionals[1] || flags.file;
      if (!filePath) {
        throw new Error("Usage: inbox import <file-path>");
      }

      process.stdout.write(`${safeJsonStringify(importInputRequestAnswers(config, filePath))}\n`);
      return;
    }
    default:
      throw new Error("Usage: inbox <list|show|answer|import> ...");
  }
}

function normalizeFlagList(value) {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function writeWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    process.stderr.write(`[workflow-warning] ${warning}\n`);
  }
}
