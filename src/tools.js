import { tool } from "@openai/agents";
import { z } from "zod";
import { evaluateQuality } from "./quality_gates.js";
import { touch } from "./state.js";

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
  async execute(_, ctx) {
    const quality = evaluateQuality(ctx.state);
    touch(ctx.state);
    return quality;
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
  async execute({ question, targetDimension, suggestedField }, ctx) {
    const answer = await ctx.io.ask(`${question}${suggestedField ? ` (field: ${suggestedField})` : ""}`);
    // Store raw Q/A trace for debugging / audit
    ctx.state.dimensions[targetDimension].data._qa = ctx.state.dimensions[targetDimension].data._qa ?? [];
    ctx.state.dimensions[targetDimension].data._qa.push({ question, answer, suggestedField, at: new Date().toISOString() });
    touch(ctx.state);
    return answer;
  }
});

export const update_dimension = tool({
  name: "update_dimension",
  description: "Update a specific dimension field in the shared RCA state.",
  parameters: z.object({
    dimension: z.enum(["incident_description", "context", "timeline", "evidence", "hypotheses"]),
    // dotted path into dimension.data, e.g. 'impact' or 'service' or 'events'
    fieldPath: z.string().min(1),
    value: z.any()
  }),
  async execute({ dimension, fieldPath, value }, ctx) {
    const data = ctx.state.dimensions[dimension].data;
    const parts = fieldPath.split(".");
    let cur = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
    touch(ctx.state);
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
    source: z.string().optional()
  }),
  async execute({ ts, label, description, source }, ctx) {
    ctx.state.dimensions.timeline.data.events.push({ ts, label, description, source: source ?? "user" });
    touch(ctx.state);
    return { ok: true, count: ctx.state.dimensions.timeline.data.events.length };
  }
});

export const add_evidence = tool({
  name: "add_evidence",
  description: "Add a piece of evidence (file/log snippet/ticket) and extract lightweight 'signals' (prototype).",
  parameters: z.object({
    title: z.string().min(2),
    kind: z.enum(["log", "ticket", "runbook", "metric", "email", "other"]),
    notes: z.string().optional()
  }),
  async execute({ title, kind, notes }, ctx) {
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
    return { id, extractedSignals };
  }
});

export const record_hypothesis = tool({
  name: "record_hypothesis",
  description: "Record a causal hypothesis and its current status (open/accepted/rejected).",
  parameters: z.object({
    statement: z.string().min(10),
    status: z.enum(["open", "accepted", "rejected"]).default("open"),
    evidenceRefs: z.array(z.string()).optional(),
    rationale: z.string().optional()
  }),
  async execute({ statement, status, evidenceRefs, rationale }, ctx) {
    const id = `h_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    ctx.state.dimensions.hypotheses.data.items.push({
      id,
      statement,
      status,
      evidenceRefs: evidenceRefs ?? [],
      rationale: rationale ?? null
    });
    touch(ctx.state);
    return { id };
  }
});

export const ALL_TOOLS = [
  evaluate_quality,
  ask_user,
  update_dimension,
  add_timeline_event,
  add_evidence,
  record_hypothesis
];
