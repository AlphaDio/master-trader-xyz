export const secretReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "ref"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["env", "state_secret", "prompt_input"] },
    ref: { type: "string" }
  }
};

export const persistedInputFieldSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "label", "required", "secret"],
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    required: { type: "boolean" },
    secret: { type: "boolean" },
    hint: { type: "string" },
    value: {},
    secret_ref: {
      oneOf: [secretReferenceSchema, { type: "null" }]
    }
  }
};

export const requestedInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "fields"],
  properties: {
    prompt: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "required", "secret", "hint"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          required: { type: "boolean" },
          secret: { type: "boolean" },
          hint: { type: "string" }
        }
      }
    }
  }
};

export const persistedInputRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "run_id", "task_id", "skill_id", "status", "prompt", "fields", "created_at", "answered_at"],
  properties: {
    id: { type: "string" },
    run_id: { type: "string" },
    task_id: { type: "string" },
    skill_id: {
      oneOf: [{ type: "string" }, { type: "null" }]
    },
    status: { type: "string", enum: ["open", "answered", "cancelled"] },
    prompt: { type: "string" },
    fields: {
      type: "array",
      minItems: 1,
      items: persistedInputFieldSchema
    },
    created_at: { type: "string" },
    answered_at: {
      oneOf: [{ type: "string" }, { type: "null" }]
    }
  }
};

export const skillRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "source_type",
    "source",
    "status",
    "title",
    "raw_markdown",
    "summary",
    "metadata",
    "integrations",
    "created_at",
    "updated_at",
    "last_fetched_at",
    "last_used_at"
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    source_type: { type: "string", enum: ["url", "file"] },
    source: { type: "string" },
    status: { type: "string", enum: ["enabled", "disabled"] },
    title: { type: "string" },
    raw_markdown: { type: "string" },
    summary: { type: "string" },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["detected_urls", "detected_actions", "warnings"],
      properties: {
        detected_urls: {
          type: "array",
          items: { type: "string" }
        },
        detected_actions: {
          type: "array",
          items: { type: "string" }
        },
        warnings: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    integrations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "tool",
          "target_dir",
          "package_dir",
          "skill_file",
          "mode",
          "status",
          "installed_at",
          "last_seen_at",
          "last_checked_at",
          "is_system"
        ],
        properties: {
          tool: { type: "string" },
          target_dir: { type: "string" },
          package_dir: { type: "string" },
          skill_file: { type: "string" },
          mode: { type: "string" },
          status: { type: "string", enum: ["installed", "missing"] },
          installed_at: { type: "string" },
          last_seen_at: { type: "string" },
          last_checked_at: { type: "string" },
          is_system: { type: "boolean" }
        }
      }
    },
    created_at: { type: "string" },
    updated_at: { type: "string" },
    last_fetched_at: { type: "string" },
    last_used_at: {
      oneOf: [{ type: "string" }, { type: "null" }]
    }
  }
};

export const workflowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "default_skill_ids", "tasks"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    default_skill_ids: {
      type: "array",
      items: { type: "string" }
    },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "goal", "outputSchema", "skill_ids", "context"],
        properties: {
          id: { type: "string" },
          goal: { type: "string" },
          use_default_skills: { type: "boolean" },
          skill_ids: {
            type: "array",
            items: { type: "string" }
          },
          context: {
            type: "object"
          },
          outputSchema: {
            type: "object"
          }
        }
      }
    }
  }
};

export const runEvaluationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "score", "summary", "strengths", "failures", "risks", "recommended_changes", "one_line_assessment"],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "partial", "failed", "blocked_waiting_for_input"]
    },
    score: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    strengths: {
      type: "array",
      items: { type: "string" }
    },
    failures: {
      type: "array",
      items: { type: "string" }
    },
    risks: {
      type: "array",
      items: { type: "string" }
    },
    recommended_changes: {
      type: "array",
      items: { type: "string" }
    },
    one_line_assessment: { type: "string" }
  }
};

export const taskStateChangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "scope", "sensitivity", "format", "summary", "value", "secret_ref"],
  properties: {
    key: { type: "string" },
    scope: {
      type: "string",
      enum: ["run", "agent"]
    },
    sensitivity: {
      type: "string",
      enum: ["public", "secret"]
    },
    format: {
      type: "string",
      enum: ["text", "json"]
    },
    summary: { type: "string" },
    value: { type: "string" },
    secret_ref: { type: "null" }
  }
};

export function buildCodexTaskResponseSchema(task) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "execution", "journal", "output", "reasoning", "input_request", "state_changes"],
    properties: {
      status: {
        type: "string",
        enum: ["completed", "partial", "failed", "blocked_waiting_for_input"]
      },
      execution: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "actions_taken", "external_calls", "artifacts_created"],
        properties: {
          summary: { type: "string" },
          actions_taken: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "summary"],
              properties: {
                type: { type: "string" },
                summary: { type: "string" }
              }
            }
          },
          external_calls: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "target", "status"],
              properties: {
                kind: { type: "string" },
                target: { type: "string" },
                status: { type: "string" }
              }
            }
          },
          artifacts_created: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "path", "description"],
              properties: {
                kind: { type: "string" },
                path: { type: "string" },
                description: { type: "string" }
              }
            }
          }
        }
      },
      journal: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "events", "conclusions"],
        properties: {
          summary: { type: "string" },
          events: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "message", "timestamp", "data"],
              properties: {
                kind: {
                  type: "string",
                  enum: ["observation", "action", "decision", "warning", "artifact"]
                },
                message: { type: "string" },
                timestamp: { type: "string" },
                data: { type: "string" }
              }
            }
          },
          conclusions: {
            type: "array",
            items: { type: "string" }
          }
        }
      },
      output: toStrictOpenAiSchema(task.outputSchema),
      reasoning: {
        type: "string",
        minLength: 1,
        maxLength: 280
      },
      input_request: requestedInputSchema,
      state_changes: {
        type: "array",
        items: taskStateChangeSchema
      }
    }
  };
}

function toStrictOpenAiSchema(schema) {
  let normalized = schema;

  if (schema.type === "object" || schema.properties) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [key, toStrictOpenAiSchema(value)])
    );

    normalized = {
      ...schema,
      type: "object",
      additionalProperties: false,
      properties,
      required: Object.keys(properties)
    };
  } else if (schema.type === "array" && schema.items) {
    normalized = {
      ...schema,
      items: toStrictOpenAiSchema(schema.items)
    };
  }

  return normalized;
}
