/**
 * Shared RCA state (in-memory for this prototype).
 * Mirrors your spec: dimensions, per-dimension metadata, gaps, confidence, etc.
 */

export const RCA_DIMENSIONS = [
  "incident_description",
  "context",
  "timeline",
  "evidence",
  "hypotheses"
];

// Which dimensions must be complete enough to stop data gathering in v1.
export const MANDATORY_DIMENSIONS = [
  "incident_description",
  "context",
  "timeline"
];

export function makeInitialState(seedIncidentDescription) {
  const now = new Date().toISOString();

  return {
    meta: {
      createdAt: now,
      updatedAt: now,
      overallCompletionPct: 0
    },

    dimensions: {
      incident_description: {
        data: {
          text: seedIncidentDescription ?? "",
          location: null,
          affectedSystems: [],
          impact: null
        },
        importance: "mandatory",
        status: "incomplete",
        confidence: 0.4,
        evidence_count: 0,
        gaps: []
      },

      context: {
        data: {
          org: null,
          service: null,
          environment: null,
          constraints: [],
          stakeholders: []
        },
        importance: "mandatory",
        status: "incomplete",
        confidence: 0.3,
        evidence_count: 0,
        gaps: []
      },

      timeline: {
        data: {
          events: [] // {ts, label, description, source}
        },
        importance: "mandatory",
        status: "incomplete",
        confidence: 0.3,
        evidence_count: 0,
        gaps: []
      },

      evidence: {
        data: {
          items: [] // {id, title, kind, notes, extractedSignals: []}
        },
        importance: "optional",
        status: "partial",
        confidence: 0.2,
        evidence_count: 0,
        gaps: []
      },

      hypotheses: {
        data: {
          items: [] // {id, statement, status: accepted|rejected|open, evidenceRefs: [], rationale}
        },
        importance: "optional",
        status: "partial",
        confidence: 0.2,
        evidence_count: 0,
        gaps: []
      }
    }
  };
}

export function touch(state) {
  state.meta.updatedAt = new Date().toISOString();
}
