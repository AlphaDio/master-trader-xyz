export const defaultWorkflow = {
  id: "crypto-base-workflow",
  name: "Crypto Base Workflow",
  default_skill_ids: [],
  tasks: [
    {
      id: "collect-base-prices",
      goal: "Find a way to get the best prices data in crypto on Base, and record them",
      skill_ids: [],
      context: {},
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["snapshot_at", "chain", "sources", "assets", "records_written"],
        properties: {
          snapshot_at: { type: "string" },
          chain: { type: "string", const: "Base" },
          sources: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "kind", "status"],
              properties: {
                name: { type: "string" },
                kind: { type: "string" },
                status: { type: "string" },
                url: { type: "string" }
              }
            }
          },
          assets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["symbol", "price_usd", "source", "observed_at"],
              properties: {
                symbol: { type: "string" },
                address: { type: "string" },
                price_usd: { type: "number" },
                liquidity_usd: { type: "number" },
                source: { type: "string" },
                observed_at: { type: "string" }
              }
            }
          },
          records_written: { type: "integer", minimum: 0 },
          notes: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    {
      id: "analyze-prices-and-portfolio",
      goal: "Analyze the prices and get intel from it and analyze the present state of the portfolio",
      skill_ids: [],
      context: {},
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["snapshot_at", "portfolio_state", "signals", "recommended_actions"],
        properties: {
          snapshot_at: { type: "string" },
          portfolio_state: {
            type: "object",
            additionalProperties: false,
            required: ["estimated_value_usd", "risk_level"],
            properties: {
              estimated_value_usd: { type: "number" },
              base_exposure_pct: { type: "number" },
              stable_exposure_pct: { type: "number" },
              risk_level: { type: "string" },
              drawdown_pct: { type: "number" }
            }
          },
          signals: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "confidence", "detail"],
              properties: {
                title: { type: "string" },
                confidence: { type: "number" },
                detail: { type: "string" }
              }
            }
          },
          recommended_actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["action", "rationale", "priority"],
              properties: {
                action: { type: "string" },
                rationale: { type: "string" },
                priority: { type: "string" }
              }
            }
          },
          warnings: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    {
      id: "execute-transactions",
      goal: "Make transactions to grow or secure the value of the portfolio",
      skill_ids: [],
      context: {},
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["snapshot_at", "actions", "portfolio_delta", "safeguards"],
        properties: {
          snapshot_at: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "status", "rationale"],
              properties: {
                type: { type: "string" },
                asset: { type: "string" },
                amount: { type: "number" },
                status: { type: "string" },
                tx_hash: { type: "string" },
                rationale: { type: "string" }
              }
            }
          },
          portfolio_delta: {
            type: "object",
            additionalProperties: false,
            required: ["estimated_value_change_usd", "risk_change"],
            properties: {
              estimated_value_change_usd: { type: "number" },
              risk_change: { type: "string" },
              fees_usd: { type: "number" }
            }
          },
          safeguards: {
            type: "array",
            items: { type: "string" }
          },
          notes: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    {
      id: "evaluate-latest-run",
      goal: "Evaluate the latest run",
      skill_ids: [],
      context: {},
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["snapshot_at", "run_assessment", "successes", "failures", "next_changes"],
        properties: {
          snapshot_at: { type: "string" },
          run_assessment: { type: "string" },
          successes: {
            type: "array",
            items: { type: "string" }
          },
          failures: {
            type: "array",
            items: { type: "string" }
          },
          next_changes: {
            type: "array",
            items: { type: "string" }
          },
          operator_notes: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  ]
};
