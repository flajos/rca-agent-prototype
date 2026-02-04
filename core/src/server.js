import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@openai/agents";
import { makeInitialState } from "./state.js";
import { makeInvestigatorAgent, makeFinalWriterAgent } from "./agents.js";
import { evaluateQuality, formatGapsSummary } from "./quality_gates.js";
import { MANDATORY_DIMENSIONS } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "..", "ui", "public");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));

const sessions = new Map();

function emit(session, event) {
  const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
  session.events.push(payload);
  for (const res of session.streams) {
    res.write(`data: ${payload}\n\n`);
  }
}

function emitError(session, message) {
  emit(session, { type: "error", message });
}

function emitState(session) {
  emit(session, { type: "state", state: session.state });
}

function buildUserStatus(quality) {
  const notes = [];
  const focus = [];

  for (const [dimName, gate] of Object.entries(quality.gates ?? {})) {
    const friendlyName = dimName.replace(/_/g, " ");
    if (gate.gaps?.length) {
      for (const gap of gate.gaps) {
        notes.push(`${friendlyName}: ${gap}`);
      }
      if (MANDATORY_DIMENSIONS.includes(dimName)) {
        focus.push(friendlyName);
      }
    }
  }

  return {
    completionPct: quality.overallCompletionPct ?? 0,
    focus: focus.length ? `Filling details for ${focus.join(", ")}.` : "Reviewing evidence.",
    notes,
    phase: quality.phase ?? "Define",
    hypothesisStats: quality.hypothesisStats ?? {
      total: 0,
      accepted: 0,
      rejected: 0,
      open: 0
    }
  };
}

function emitStatus(session, quality) {
  const status = buildUserStatus(quality);
  emit(session, { type: "status", ...status });
}

function deriveOptionsFromState(targetDimension, suggestedField, state) {
  if (!targetDimension || !suggestedField) return [];
  const out = new Set();
  const dimData = state.dimensions?.[targetDimension]?.data ?? {};

  const directValue = dimData[suggestedField];
  if (typeof directValue === "string" && directValue.trim()) out.add(directValue.trim());

  const items = state.dimensions?.evidence?.data?.items ?? [];
  const labelKey = `${targetDimension}__${suggestedField}`;
  for (const item of items) {
    for (const sig of item.extractedSignals ?? []) {
      if (sig?.type === "labeled_fact" && sig.key === labelKey && sig.value) {
        out.add(String(sig.value).trim());
      }
    }
  }

  return Array.from(out);
}

function makeWebIO(session) {
  return {
    async ask(promptOrQuestion) {
      const prompt =
        typeof promptOrQuestion === "string"
          ? promptOrQuestion
          : promptOrQuestion?.prompt ?? "Please provide input.";
      const targetDimension =
        typeof promptOrQuestion === "object" ? promptOrQuestion?.targetDimension ?? null : null;
      const suggestedField =
        typeof promptOrQuestion === "object" ? promptOrQuestion?.suggestedField ?? null : null;
      let inputType =
        typeof promptOrQuestion === "object" ? promptOrQuestion?.inputType ?? "free_text" : "free_text";
      let options = typeof promptOrQuestion === "object" ? promptOrQuestion?.options ?? [] : [];

      // If no options provided, derive from current state/evidence (no hardcoded defaults).
      if (!options.length && targetDimension && suggestedField) {
        options = deriveOptionsFromState(targetDimension, suggestedField, session.state);
      }

      // If still no options, force free text to avoid empty UI controls.
      if (!options.length && inputType !== "free_text") {
        emit(session, { type: "log", message: "[question] no options provided; falling back to free text" });
        inputType = "free_text";
      }

      const sig = `${targetDimension ?? ""}::${suggestedField ?? ""}::${prompt}`;
      session.questionCounts = session.questionCounts ?? new Map();
      session.skippedQuestions = session.skippedQuestions ?? new Set();

      if (session.skippedQuestions.has(sig)) {
        emit(session, { type: "log", message: "[question] skipped by user earlier; auto-skipping" });
        return "";
      }

      const count = session.questionCounts.get(sig) ?? 0;
      if (count >= 2) {
        emit(session, { type: "log", message: "[question] repeated; auto-skipping" });
        return "";
      }
      session.questionCounts.set(sig, count + 1);

      const q = {
        id: crypto.randomUUID(),
        prompt,
        targetDimension,
        suggestedField,
        inputType,
        options,
        sig
      };
      const promise = new Promise((resolve, reject) => {
        const item = { q, resolve, reject };
        if (!session.pendingQuestion) {
          session.pendingQuestion = q;
          session.pendingResolve = resolve;
          session.pendingReject = reject;
          emit(session, { type: "question", question: q });
        } else {
          session.questionQueue.push(item);
          emit(session, { type: "log", message: "[question] queued" });
        }
      });
      return promise;
    },
    log(msg) {
      emit(session, { type: "log", message: msg });
      emitState(session);
    },
    status(quality) {
      emitStatus(session, quality);
    },
    async close() {}
  };
}

function truncateText(text, maxChars = 20000) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function extractTextFromFile(file) {
  if (!file?.buffer) return "";
  return file.buffer.toString("utf8");
}

function buildKeyCatalog(state) {
  const catalog = [];
  for (const [dimension, dimValue] of Object.entries(state.dimensions)) {
    const data = dimValue.data ?? {};
    for (const key of Object.keys(data)) {
      catalog.push({
        dimension,
        key,
        label: `${dimension}__${key}`
      });
    }
  }
  return catalog;
}

function normalizeKeyName(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveKeyLabel(rawKey, catalog) {
  const normalized = normalizeKeyName(rawKey);
  const direct = catalog.find(c => normalizeKeyName(c.key) === normalized);
  if (direct) return direct.label;

  const aliasMap = {
    vessel: "context__environment",
    environment: "context__environment",
    position: "incident_description__location",
    location: "incident_description__location",
    "reported by": "context__org",
    "reporting officer": "context__org",
    "responsible officer": "context__org",
    impact: "incident_description__impact",
    service: "context__service",
    system: "context__service",
    component: "context__service",
    team: "context__org",
    org: "context__org",
    organization: "context__org",
    date: "timeline__events",
    time: "timeline__events"
  };

  for (const [alias, label] of Object.entries(aliasMap)) {
    if (normalized.includes(alias)) return label;
  }

  return null;
}

function extractFactsFromText(text) {
  const facts = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const key = match[1].trim();
      let value = match[2].trim();
      if (!value) {
        // Handle keys with value on the next line (e.g., "Reported by:")
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next) {
            value = next;
            break;
          }
        }
      }
      if (value) {
        facts.push({ key, value });
      }
    }
  }
  return facts;
}

function extractSignalsFromText(text, state) {
  const signals = [];
  const lower = text.toLowerCase();
  const catalog = buildKeyCatalog(state);
  const facts = extractFactsFromText(text);

  for (const fact of facts) {
    const label = resolveKeyLabel(fact.key, catalog);
    if (label) {
      signals.push({
        type: "labeled_fact",
        key: label,
        value: fact.value
      });
    }
  }

  if (lower.includes("fire")) {
    signals.push({ type: "incident_type", value: "fire" });
  }
  if (lower.includes("smoke")) {
    signals.push({ type: "symptom", value: "smoke observed" });
  }
  if (lower.includes("injury")) {
    const value = lower.includes("no injur")
      ? "no injuries reported"
      : "injuries mentioned";
    signals.push({ type: "impact", value });
  }

  const locationMatch = text.match(/Location:\s*(.+)/i);
  if (locationMatch?.[1]) {
    signals.push({ type: "incident_location", value: locationMatch[1].trim() });
  }

  const dateMatch = text.match(/Date:\s*(.+)/i);
  const timeMatch = text.match(/Time:\s*(.+)/i);
  if (dateMatch?.[1] || timeMatch?.[1]) {
    const ts = [dateMatch?.[1], timeMatch?.[1]].filter(Boolean).join(" ");
    signals.push({ type: "incident_time", value: ts.trim() });
  }

  return signals;
}

function applySignalsToState(session, signals) {
  const incident = session.state.dimensions.incident_description.data;
  const timeline = session.state.dimensions.timeline.data;
  const context = session.state.dimensions.context.data;

  for (const signal of signals) {
    if (signal.type === "labeled_fact" && signal.key) {
      const [dimension, key] = signal.key.split("__");
      if (dimension === "incident_description") {
        incident[key] = signal.value;
      } else if (dimension === "context") {
        context[key] = signal.value;
      } else if (dimension === "timeline" && key === "events") {
        timeline.events.push({
          ts: signal.value,
          label: "Timeline detail",
          description: "Timestamp or event detail from evidence.",
          source: "evidence"
        });
      }
    }
    if (signal.type === "incident_location" && !incident.location) {
      incident.location = signal.value;
    }
    if (signal.type === "impact" && !incident.impact) {
      incident.impact = signal.value;
    }
    if (signal.type === "incident_time") {
      timeline.events.push({
        ts: signal.value,
        label: "Incident reported",
        description: "Timestamp referenced in evidence file.",
        source: "evidence"
      });
    }
  }
}

function isPendingQuestionStillValid(session) {
  const q = session.pendingQuestion;
  if (!q) return true;
  if (!q.targetDimension) return true;

  const dim = session.state.dimensions[q.targetDimension];
  if (!dim) return true;

  if (q.suggestedField) {
    const value = dim.data?.[q.suggestedField];
    return !value;
  }

  // Fallback: if dimension has no gaps, drop the question.
  return (dim.gaps ?? []).length > 0;
}

function clearPendingQuestion(session, reason) {
  if (!session.pendingQuestion) return;
  emit(session, { type: "log", message: `[question] cleared (${reason})` });
  session.pendingQuestion = null;
  session.pendingResolve = null;
  session.pendingReject = null;
  emit(session, { type: "question", question: null });
}

function reevaluate(session, reason) {
  const quality = evaluateQuality(session.state);
  emit(session, {
    type: "log",
    message: `[quality] reevaluated after ${reason} -> ${quality.overallCompletionPct}%`
  });
  emitStatus(session, quality);
  emitState(session);

  if (!isPendingQuestionStillValid(session)) {
    clearPendingQuestion(session, "answered by evidence");
  }

  return quality;
}

function addEvidenceFromFile(session, file, notes, extractedSignals = []) {
  const id = `ev_${crypto.randomUUID()}`;
  session.state.dimensions.evidence.data.items.push({
    id,
    title: file.originalname,
    kind: "other",
    notes: notes ?? null,
    extractedSignals
  });
  session.state.dimensions.evidence.evidence_count =
    session.state.dimensions.evidence.data.items.length;
  emit(session, {
    type: "log",
    message: `[evidence] uploaded file "${file.originalname}" (${file.size} bytes)`
  });
  emitState(session);
  return id;
}

async function startInvestigation(session) {
  const investigator = makeInvestigatorAgent();
  const initialPrompt = `
Start investigating based on the incident description in ctx.state.
You MUST call evaluate_quality first, then proceed.
`.trim();

  try {
    const result = await run(investigator, initialPrompt, {
      context: { state: session.state, io: session.io },
      maxTurns: 100
    });

    session.lastResult = result.finalOutput ?? "";
    emit(session, { type: "result", output: session.lastResult });

    const quality = evaluateQuality(session.state);
    emit(session, {
      type: "log",
      message: `[quality] overall ${quality.overallCompletionPct}% | ${formatGapsSummary(quality)}`
    });
    emitStatus(session, quality);
    emitState(session);

    if ((session.lastResult ?? "").trim() === "READY_FOR_FINAL_RCA") {
      session.readyForFinal = true;
      emit(session, { type: "ready_for_final" });
    }
  } catch (err) {
    emitError(session, err?.message ?? String(err));
  }
}

async function generateFinal(session) {
  const finalWriter = makeFinalWriterAgent();
  const finalPrompt = `
Generate the final RCA markdown document using this JSON state:

${JSON.stringify(session.state, null, 2)}
`.trim();

  try {
    session.finalInProgress = true;
    const result = await run(finalWriter, finalPrompt, {
      context: { state: session.state, io: session.io },
      maxTurns: 100,
      stream: true
    });

    let output = "";
    const textStream = result.toTextStream({ compatibleWithNodeStreams: true });
    for await (const chunk of textStream) {
      const delta = chunk.toString();
      output += delta;
      emit(session, { type: "final_delta", delta });
    }

    await result.completed;
    session.finalOutput = output;
    emit(session, { type: "final", output: session.finalOutput });
    session.finalInProgress = false;
  } catch (err) {
    session.finalInProgress = false;
    emitError(session, err?.message ?? String(err));
  }
}

app.get("/api/stream/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  session.streams.add(res);

  // Send backlog so UI can hydrate.
  for (const payload of session.events) {
    res.write(`data: ${payload}\n\n`);
  }

  req.on("close", () => {
    session.streams.delete(res);
  });
});

app.post("/api/start", upload.array("files"), async (req, res) => {
  const incident = (req.body.incident ?? "").toString().trim();
  const state = makeInitialState(incident);
  const sessionId = crypto.randomUUID();

  const session = {
    id: sessionId,
    state,
    io: null,
    pendingQuestion: null,
    pendingResolve: null,
    pendingReject: null,
    questionQueue: [],
    questionCounts: new Map(),
    skippedQuestions: new Set(),
    streams: new Set(),
    events: [],
    lastResult: "",
    finalOutput: "",
    readyForFinal: false
  };

  session.io = makeWebIO(session);
  sessions.set(sessionId, session);

  const files = req.files ?? [];
  for (const file of files) {
    const content = truncateText(extractTextFromFile(file));
    const notes = content ? `Uploaded file content:\n${content}` : null;
    const signals = content ? extractSignalsFromText(content, session.state) : [];
    addEvidenceFromFile(session, file, notes, signals);
    applySignalsToState(session, signals);
    reevaluate(session, "initial evidence upload");
    if (!incident && content) {
      session.state.dimensions.incident_description.data.text = content;
    }
  }

  emit(session, { type: "log", message: "[session] started" });
  emitState(session);
  emitStatus(session, evaluateQuality(session.state));

  startInvestigation(session);

  res.json({ sessionId });
});

app.post("/api/answer", (req, res) => {
  const { sessionId, answer } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (!session.pendingResolve) {
    res.status(400).json({ error: "no_pending_question" });
    return;
  }
  const text = (answer ?? "").toString().trim();
  session.pendingResolve(text);
  emit(session, { type: "log", message: `[user] ${text || "(empty)"}` });
  session.pendingResolve = null;
  session.pendingReject = null;
  session.pendingQuestion = null;

  if (session.questionQueue.length > 0) {
    const next = session.questionQueue.shift();
    session.pendingQuestion = next.q;
    session.pendingResolve = next.resolve;
    session.pendingReject = next.reject;
    emit(session, { type: "question", question: next.q });
  } else {
    emit(session, { type: "question", question: null });
  }

  res.json({ ok: true });
});

app.post("/api/continue", async (req, res) => {
  const { sessionId } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (session.pendingQuestion) {
    if (session.pendingQuestion.sig) {
      session.skippedQuestions.add(session.pendingQuestion.sig);
    }
    clearPendingQuestion(session, "manual_continue");
  }
  emit(session, { type: "log", message: "[user] continue anyway" });
  startInvestigation(session);
  res.json({ ok: true });
});

app.post("/api/evidence", upload.single("file"), (req, res) => {
  const { sessionId, notes } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "missing_file" });
    return;
  }
  const content = truncateText(extractTextFromFile(req.file));
  const combinedNotes = [notes, content ? `Uploaded file content:\n${content}` : null]
    .filter(Boolean)
    .join("\n\n");
  const signals = content ? extractSignalsFromText(content, session.state) : [];
  const id = addEvidenceFromFile(session, req.file, combinedNotes, signals);
  applySignalsToState(session, signals);
  reevaluate(session, "evidence upload");
  res.json({ ok: true, id });
});

app.post("/api/final", (req, res) => {
  const { sessionId } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (session.finalOutput) {
    res.json({ ok: true, output: session.finalOutput });
    return;
  }
  if (session.finalInProgress) {
    res.json({ ok: true, inProgress: true });
    return;
  }
  generateFinal(session);
  res.json({ ok: true });
});

app.get("/api/state/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json({ state: session.state });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`RCA workbench listening on http://localhost:${port}`);
});
