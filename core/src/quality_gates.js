import { MANDATORY_DIMENSIONS } from "./state.js";

/**
 * Quality gates (prototype-level heuristics).
 * You can replace each gate with stricter logic or LLM-based evaluation later.
 */

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function evaluateQuality(state) {
  const gates = {};
  let sumPct = 0;
  let count = 0;
  let phase = "Define";
  let hypothesisStats = {
    total: 0,
    accepted: 0,
    rejected: 0,
    open: 0,
    withEvidence: 0
  };

  // Incident description gate
  {
    const d = state.dimensions.incident_description.data;
    const gaps = [];
    if (!d.text || d.text.trim().length < 40) gaps.push("Incident description is too short / vague.");
    if (!d.impact) gaps.push("Impact is missing (what user-facing/internal impact?).");
    if (!d.location) gaps.push("Location/site is missing (if applicable).");
    const completion = clamp(100 - gaps.length * 25, 0, 100);

    gates.incident_description = { completionPct: completion, gaps };
  }

  // Context gate
  {
    const d = state.dimensions.context.data;
    const gaps = [];
    const serviceValue = d.service ?? d.service_system_component ?? null;
    const orgValue = d.org ?? d.owning_org_team ?? null;
    if (!serviceValue) gaps.push("Service/system/component is missing.");
    if (!d.environment) gaps.push("Environment is missing (prod/stage, vessel/site, etc.).");
    if (!orgValue) gaps.push("Owning org/team is missing.");
    const completion = clamp(100 - gaps.length * 25, 0, 100);

    gates.context = { completionPct: completion, gaps };
  }

  // Timeline gate
  {
    const d = state.dimensions.timeline.data;
    const gaps = [];
    if (!Array.isArray(d.events) || d.events.length < 3) gaps.push("Timeline needs at least 3 events (start, detection, mitigation).");
    // Basic check: timestamps present for all events
    const missingTs = (d.events || []).filter(e => !e.ts).length;
    if (missingTs > 0) gaps.push("Some timeline events are missing timestamps.");
    const completion = clamp(100 - gaps.length * 35, 0, 100);

    gates.timeline = { completionPct: completion, gaps };
  }

  // Evidence gate (optional)
  {
    const d = state.dimensions.evidence.data;
    const gaps = [];
    if (!Array.isArray(d.items) || d.items.length === 0) gaps.push("No evidence attached yet.");
    const completion = clamp(100 - gaps.length * 40, 0, 100);
    gates.evidence = { completionPct: completion, gaps };
  }

  // Hypotheses gate (optional)
  {
    const d = state.dimensions.hypotheses.data;
    const gaps = [];
    const items = Array.isArray(d.items) ? d.items : [];
    const acceptedItems = items.filter(i => i.status === "accepted");
    const accepted = acceptedItems.length;
    const rejected = items.filter(i => i.status === "rejected").length;
    const open = items.filter(i => i.status === "open").length;
    const withEvidence = items.filter(i => (i.evidenceRefs?.length ?? 0) > 0 || i.rationale).length;
    const acceptedSystemic = acceptedItems.filter(i =>
      ["process", "organizational"].includes(i.category ?? "technical")
    ).length;

    hypothesisStats = {
      total: items.length,
      accepted,
      rejected,
      open,
      withEvidence
    };

    if (items.length < 2) gaps.push("At least two causal hypotheses should be recorded.");
    if (items.length > 0 && withEvidence < items.length) {
      gaps.push("Some hypotheses are missing evidence references or rationale.");
    }
    if (items.length > 0 && accepted === 0) {
      gaps.push("No confirmed root cause yet (no accepted hypotheses).");
    }
    if (accepted > 0 && acceptedSystemic === 0) {
      gaps.push("No organizational/process root cause identified behind the technical failure.");
    }

    const completion = clamp(100 - gaps.length * 30, 0, 100);
    gates.hypotheses = { completionPct: completion, gaps };
  }

  for (const [k, v] of Object.entries(gates)) {
    sumPct += v.completionPct;
    count += 1;
    state.dimensions[k].gaps = v.gaps;
    state.dimensions[k].status =
      v.completionPct >= 85 ? "complete" : (v.completionPct >= 45 ? "partial" : "incomplete");
    // crude confidence proxy
    state.dimensions[k].confidence = clamp(v.completionPct / 100, 0.1, 0.95);
  }

  const overall = Math.round(sumPct / Math.max(1, count));
  state.meta.overallCompletionPct = overall;

  const mandatoryGaps = [];
  for (const dim of MANDATORY_DIMENSIONS) {
    mandatoryGaps.push(...(gates[dim]?.gaps ?? []).map(g => ({ dimension: dim, gap: g })));
  }

  const mandatoryComplete =
    mandatoryGaps.length === 0 ||
    MANDATORY_DIMENSIONS.every(d => (gates[d]?.completionPct ?? 0) >= 85);

  if (!mandatoryComplete) {
    phase = "Define";
  } else if (hypothesisStats.total < 2) {
    phase = "Generate";
  } else if (hypothesisStats.accepted === 0 && hypothesisStats.open > 0) {
    phase = "Test";
  } else if (hypothesisStats.accepted === 0 && hypothesisStats.open === 0) {
    phase = "Confirm";
  } else {
    phase = "Confirm";
  }

  const readyToStop =
    mandatoryComplete &&
    (hypothesisStats.accepted > 0 || (hypothesisStats.total >= 2 && hypothesisStats.open === 0)) &&
    (hypothesisStats.accepted === 0 ||
      ["process", "organizational"].some(cat =>
        (state.dimensions.hypotheses.data.items || []).some(
          i => i.status === "accepted" && (i.category ?? "technical") === cat
        )
      ));

  return {
    overallCompletionPct: overall,
    gates,
    mandatoryGaps,
    readyToStop,
    phase,
    hypothesisStats
  };
}

export function formatGapsSummary(quality) {
  if (!quality.mandatoryGaps.length) return "No mandatory gaps.";
  return quality.mandatoryGaps.map(g => `- [${g.dimension}] ${g.gap}`).join("\n");
}
