import { tool } from "@openai/agents";
import { z } from "zod";
import { evaluateQuality } from "./quality_gates.js";
import { touch } from "./state.js";

function getRcaContext(runContext) {
  // @openai/agents passes a RunContext wrapper; our data lives in runContext.context
  // but we also support direct ctx objects for tests.
  if (runContext?.context) return runContext.context;
  return runContext;
}

/**
 * Tools are the “actions” the agent can take.
 * In a real product these would integrate with:
 * - DB
 * - internal docs / KB retrieval
 * - evidence validation & extraction workers
 * - ticketing / ERP
 *
 * Here we prototype the shape + state transitions.
 */

export const evaluate_quality = tool({
  name: "evaluate_quality",
  description: "Evaluate current RCA completeness and return gaps + completion metrics.",
  parameters: z.object({}),
  async execute(_, runContext) {
    const ctx = getRcaContext(runContext);
    const quality = evaluateQuality(ctx.state);
    touch(ctx.state);
    ctx.io?.log?.(
      `[quality] overall ${quality.overallCompletionPct}% | readyToStop=${quality.readyToStop}`
    );
    ctx.io?.status?.(quality);
    return quality;
  }
});

export const get_state_snapshot = tool({
  name: "get_state_snapshot",
  description: "Return the full RCA state snapshot for the agent to inspect.",
  parameters: z.object({}),
  async execute(_, runContext) {
    const ctx = getRcaContext(runContext);
    return ctx.state;
  }
});

export const ask_user = tool({
  name: "ask_user",
  description: "Ask the user a targeted question to fill a gap. Returns the user's answer as plain text.",
  parameters: z.object({
    question: z.string().min(3),
    targetDimension: z.enum(["incident_description", "context", "timeline", "evidence", "hypotheses"]),
    // Must be present in tool schema "required"; allow null when not provided.
    suggestedField: z.string().nullable().default(null)
  }),
  async execute({ question, targetDimension, suggestedField }, runContext) {
    const ctx = getRcaContext(runContext);
    ctx.io?.log?.(
      `[ask_user] ${targetDimension}${suggestedField ? `.${suggestedField}` : ""}: ${question}`
    );
    const answer = await ctx.io.ask({
      prompt: `${question}${suggestedField ? ` (field: ${suggestedField})` : ""}`,
      targetDimension,
      suggestedField
    });
    // Store raw Q/A trace for debugging / audit
    ctx.state.dimensions[targetDimension].data._qa = ctx.state.dimensions[targetDimension].data._qa ?? [];
    ctx.state.dimensions[targetDimension].data._qa.push({ question, answer, suggestedField, at: new Date().toISOString() });
    touch(ctx.state);
    return answer;
  }
});

const updateDimensionPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null()
]);

const updateDimensionValueSchema = z.union([
  updateDimensionPrimitiveSchema,
  z.array(updateDimensionPrimitiveSchema),
  z.record(updateDimensionPrimitiveSchema)
]);

export const update_dimension = tool({
  name: "update_dimension",
  description: "Update a specific dimension field in the shared RCA state.",
  parameters: z.object({
    dimension: z.enum(["incident_description", "context", "timeline", "evidence", "hypotheses"]),
    // dotted path into dimension.data, e.g. 'impact' or 'service' or 'events'
    fieldPath: z.string().min(1),
    value: updateDimensionValueSchema
  }),
  async execute({ dimension, fieldPath, value }, runContext) {
    const ctx = getRcaContext(runContext);
    const data = ctx.state.dimensions[dimension].data;
    const parts = fieldPath.split(".");
    let cur = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;

    // Normalize common aliases for context fields.
    if (dimension === "context") {
      if (fieldPath === "service_system_component" || fieldPath === "service_or_component") {
        data.service = value;
      }
      if (fieldPath === "owning_org_team" || fieldPath === "owning_team") {
        data.org = value;
      }
    }

    touch(ctx.state);
    ctx.io?.log?.(`[update_dimension] ${dimension}.${fieldPath}`);
    const quality = evaluateQuality(ctx.state);
    ctx.io?.status?.(quality);
    return { ok: true };
  }
});

export const add_timeline_event = tool({
  name: "add_timeline_event",
  description: "Append a timeline event (timestamped) to the RCA timeline.",
  parameters: z.object({
    ts: z.string().describe("ISO timestamp or best-known time (e.g. 2026-02-03T10:15Z or 'approx 10:00 local')"),
    label: z.string().min(2),
    description: z.string().min(5),
    // Must be present in tool schema "required"; allow null when not provided.
    source: z.string().nullable().default(null)
  }),
  async execute({ ts, label, description, source }, runContext) {
    const ctx = getRcaContext(runContext);
    ctx.state.dimensions.timeline.data.events.push({ ts, label, description, source: source ?? "user" });
    touch(ctx.state);
    ctx.io?.log?.(`[add_timeline_event] ${label} @ ${ts}`);
    const quality = evaluateQuality(ctx.state);
    ctx.io?.status?.(quality);
    return { ok: true, count: ctx.state.dimensions.timeline.data.events.length };
  }
});

export const add_evidence = tool({
  name: "add_evidence",
  description: "Add a piece of evidence (file/log snippet/ticket) and extract lightweight 'signals' (prototype).",
  parameters: z.object({
    title: z.string().min(2),
    kind: z.enum(["log", "ticket", "runbook", "metric", "email", "other"]),
    // Must be present in tool schema "required"; allow null when not provided.
    notes: z.string().nullable().default(null)
  }),
  async execute({ title, kind, notes }, runContext) {
    const ctx = getRcaContext(runContext);
    const id = `ev_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    const extractedSignals = [];
    // very naive signal extraction; replace with your real LLM extraction pipeline
    const text = `${title} ${notes ?? ""}`.toLowerCase();
    if (text.includes("timeout")) extractedSignals.push({ type: "symptom", value: "timeouts observed" });
    if (text.includes("deploy")) extractedSignals.push({ type: "change_event", value: "deployment mentioned" });
    if (text.includes("db") || text.includes("database")) extractedSignals.push({ type: "suspect_component", value: "database mentioned" });

    ctx.state.dimensions.evidence.data.items.push({ id, title, kind, notes: notes ?? null, extractedSignals });
    ctx.state.dimensions.evidence.evidence_count = ctx.state.dimensions.evidence.data.items.length;
    touch(ctx.state);
    ctx.io?.log?.(`[add_evidence] ${title} (${kind})`);
    const quality = evaluateQuality(ctx.state);
    ctx.io?.status?.(quality);
    return { id, extractedSignals };
  }
});

export const record_hypothesis = tool({
  name: "record_hypothesis",
  description: "Record a causal hypothesis and its current status (open/accepted/rejected).",
  parameters: z.object({
    statement: z.string().min(10),
    status: z.enum(["open", "accepted", "rejected"]).default("open"),
    // Must be present in tool schema "required".
    evidenceRefs: z.array(z.string()).default([]),
    rationale: z.string().nullable().default(null)
  }),
  async execute({ statement, status, evidenceRefs, rationale }, runContext) {
    const ctx = getRcaContext(runContext);
    const id = `h_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    ctx.state.dimensions.hypotheses.data.items.push({
      id,
      statement,
      status,
      evidenceRefs: evidenceRefs ?? [],
      rationale: rationale ?? null
    });
    touch(ctx.state);
    ctx.io?.log?.(`[record_hypothesis] ${status}: ${statement.slice(0, 80)}`);
    const quality = evaluateQuality(ctx.state);
    ctx.io?.status?.(quality);
    return { id };
  }
});

export const record_why_chain = tool({
  name: "record_why_chain",
  description: "Record a 5-Whys causal chain used to generate hypotheses.",
  parameters: z.object({
    problem: z.string().min(5),
    steps: z.array(
      z.object({
        why: z.string().min(3),
        because: z.string().min(3)
      })
    )
  }),
  async execute({ problem, steps }, runContext) {
    const ctx = getRcaContext(runContext);
    const id = `w_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    ctx.state.dimensions.hypotheses.data.why_chains.push({
      id,
      problem,
      steps,
      createdAt: new Date().toISOString()
    });
    touch(ctx.state);
    ctx.io?.log?.(`[record_why_chain] ${problem}`);
    const quality = evaluateQuality(ctx.state);
    ctx.io?.status?.(quality);
    return { id };
  }
});

export const ALL_TOOLS = [
  get_state_snapshot,
  evaluate_quality,
  ask_user,
  update_dimension,
  add_timeline_event,
  add_evidence,
  record_hypothesis,
  record_why_chain
];
