import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@openai/agents";
import { makeInitialState } from "./state.js";
import { makeInvestigatorAgent, makeFinalWriterAgent } from "./agents.js";
import { evaluateQuality, formatGapsSummary } from "./quality_gates.js";

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

function emitState(session) {
  emit(session, { type: "state", state: session.state });
}

function makeWebIO(session) {
  return {
    async ask(prompt) {
      const q = {
        id: crypto.randomUUID(),
        prompt
      };
      session.pendingQuestion = q;
      emit(session, { type: "question", question: q });
      return new Promise((resolve, reject) => {
        session.pendingResolve = resolve;
        session.pendingReject = reject;
      });
    },
    log(msg) {
      emit(session, { type: "log", message: msg });
      emitState(session);
    },
    async close() {}
  };
}

function addEvidenceFromFile(session, file, notes) {
  const id = `ev_${crypto.randomUUID()}`;
  session.state.dimensions.evidence.data.items.push({
    id,
    title: file.originalname,
    kind: "other",
    notes: notes ?? null,
    extractedSignals: []
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
    emitState(session);

    if ((session.lastResult ?? "").trim() === "READY_FOR_FINAL_RCA") {
      session.readyForFinal = true;
      emit(session, { type: "ready_for_final" });
    }
  } catch (err) {
    emit(session, { type: "error", message: err?.message ?? String(err) });
  }
}

async function generateFinal(session) {
  const finalWriter = makeFinalWriterAgent();
  const finalPrompt = `
Generate the final RCA markdown document using this JSON state:

${JSON.stringify(session.state, null, 2)}
`.trim();

  try {
    const result = await run(finalWriter, finalPrompt, {
      context: { state: session.state, io: session.io },
      maxTurns: 100
    });
    session.finalOutput = result.finalOutput ?? "";
    emit(session, { type: "final", output: session.finalOutput });
  } catch (err) {
    emit(session, { type: "error", message: err?.message ?? String(err) });
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
    addEvidenceFromFile(session, file);
  }

  emit(session, { type: "log", message: "[session] started" });
  emitState(session);

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
  const id = addEvidenceFromFile(session, req.file, notes);
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
