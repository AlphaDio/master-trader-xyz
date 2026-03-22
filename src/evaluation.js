import path from "node:path";
import { runCodexStructured } from "./codex.js";
import { runEvaluationSchema } from "./schemas.js";
import { validateOrThrow } from "./validation.js";

export async function evaluateRun({ config, runState, artifactsDir }) {
  const evaluationDir = path.join(artifactsDir, "evaluation");
  const prompt = buildEvaluationPrompt(runState);
  const result = await runCodexStructured({
    config,
    schema: runEvaluationSchema,
    prompt,
    artifactDir: evaluationDir,
    artifactPrefix: "evaluation",
    redactions: []
  });

  if (!result.parsed) {
    throw new Error("Codex did not return a run evaluation.");
  }

  return validateOrThrow(runEvaluationSchema, result.parsed, "Run evaluation");
}

function buildEvaluationPrompt(runState) {
  return [
    "You are evaluating a workflow run executed by a Node.js agent.",
    "Return only JSON that matches the provided schema.",
    "",
    "Requirements:",
    "- Fill every schema field.",
    "- Evaluate what worked and what failed.",
    "- Mention risks in free text only.",
    "- Consider task_results, state_change_log, external_calls, blocked input, blocked external dependencies, and final run status together.",
    "- Keep score between 0 and 1.",
    "- Keep one_line_assessment to one sentence.",
    "",
    "Run State JSON:",
    JSON.stringify(runState, null, 2),
    ""
  ].join("\n");
}
