const statusText = document.getElementById("statusText");
const incidentText = document.getElementById("incidentText");
const incidentFiles = document.getElementById("incidentFiles");
const startBtn = document.getElementById("startBtn");
const questionBox = document.getElementById("questionBox");
const answerText = document.getElementById("answerText");
const answerBtn = document.getElementById("answerBtn");
const logEl = document.getElementById("log");
const stateView = document.getElementById("stateView");
const finalBtn = document.getElementById("finalBtn");
const finalView = document.getElementById("finalView");
const finalPreview = document.getElementById("finalPreview");
const finalViewTab = document.getElementById("finalViewTab");
const finalPreviewTab = document.getElementById("finalPreviewTab");
const finalFullscreenBtn = document.getElementById("finalFullscreenBtn");
const evidenceFile = document.getElementById("evidenceFile");
const evidenceNotes = document.getElementById("evidenceNotes");
const evidenceBtn = document.getElementById("evidenceBtn");
const incidentSection = document.getElementById("incidentSection");
const questionSection = document.getElementById("questionSection");
const evidenceSection = document.getElementById("evidenceSection");
const questionOptions = document.getElementById("questionOptions");
const questionPills = document.getElementById("questionPills");
const questionRadios = document.getElementById("questionRadios");
const continueBtn = document.getElementById("continueBtn");
const statusCompletion = document.getElementById("statusCompletion");
const statusFocus = document.getElementById("statusFocus");
const statusNextQuestion = document.getElementById("statusNextQuestion");
const statusNotes = document.getElementById("statusNotes");
const statusPhase = document.getElementById("statusPhase");
const statusHypotheses = document.getElementById("statusHypotheses");

let sessionId = null;
let eventSource = null;
let latestState = null;

function clearQuestionOptions() {
  questionOptions.classList.add("hidden");
  questionPills.innerHTML = "";
  questionRadios.innerHTML = "";
  questionRadios.classList.add("hidden");
}

function renderPills(options) {
  questionPills.innerHTML = "";
  const values = new Set(
    answerText.value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pill${values.has(opt) ? " active" : ""}`;
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      if (values.has(opt)) {
        values.delete(opt);
      } else {
        values.add(opt);
      }
      answerText.value = Array.from(values).join(", ");
      renderPills(options);
    });
    questionPills.appendChild(btn);
  }
}

function renderRadios(options) {
  questionRadios.innerHTML = "";
  questionRadios.classList.remove("hidden");
  for (const opt of options) {
    const label = document.createElement("label");
    label.className = "radio-pill";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "question_radio";
    input.value = opt;
    input.addEventListener("change", () => {
      answerText.value = opt;
      const pills = questionRadios.querySelectorAll(".radio-pill");
      pills.forEach((p) => p.classList.remove("active"));
      label.classList.add("active");
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(opt));
    questionRadios.appendChild(label);
  }
}

function setStatus(text) {
  statusText.textContent = text;
}

function appendLog(message, type = "log") {
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.prepend(entry);
}

function setQuestion(question) {
  if (!question) {
    questionBox.textContent = "No pending questions.";
    questionBox.classList.add("muted");
    answerBtn.disabled = true;
    questionSection.classList.add("hidden");
    statusNextQuestion.textContent = "None.";
    statusNextQuestion.classList.add("muted");
    clearQuestionOptions();
    continueBtn.classList.add("hidden");
    return;
  }
  questionBox.textContent = question.prompt;
  questionBox.classList.remove("muted");
  answerBtn.disabled = false;
  questionSection.classList.remove("hidden");
  statusNextQuestion.textContent = question.prompt;
  statusNextQuestion.classList.remove("muted");
  continueBtn.classList.remove("hidden");

  clearQuestionOptions();
  const options = Array.isArray(question.options) ? question.options : [];
  const inputType = question.inputType ?? "free_text";

  if (options.length) {
    questionOptions.classList.remove("hidden");
    if (inputType === "multi_select") {
      renderPills(options);
    } else if (inputType === "single_select" || inputType === "yes_no") {
      renderRadios(options);
    } else {
      renderPills(options);
    }
  }
}

function updateState(state) {
  latestState = state;
  stateView.textContent = JSON.stringify(state, null, 2);
}

function renderMarkdown(md) {
  let html = md;
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/^\s*-\s+(.*)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = `<p>${html}</p>`;
  return html;
}

function setFinalViewTab(tab) {
  const isPreview = tab === "preview";
  finalViewTab.classList.toggle("active", !isPreview);
  finalPreviewTab.classList.toggle("active", isPreview);
  finalView.classList.toggle("hidden", isPreview);
  finalPreview.classList.toggle("hidden", !isPreview);
}

function openFullscreenPreview() {
  const overlay = document.createElement("div");
  overlay.className = "fullscreen-overlay";
  overlay.innerHTML = `
    <div class="fullscreen-header">
      <h2>Final RCA Preview</h2>
      <button id="closeFullscreen" class="tab-btn">Close</button>
    </div>
    <div class="fullscreen-body">${renderMarkdown(finalView.textContent || "")}</div>
  `;
  document.body.appendChild(overlay);
  const closeBtn = overlay.querySelector("#closeFullscreen");
  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}

function connectStream(id) {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource(`/api/stream/${id}`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case "log":
        appendLog(data.message, "log");
        break;
      case "question":
        if (data.question) {
          appendLog("Agent asked a question.", "question");
          setQuestion(data.question);
        } else {
          appendLog("Pending question cleared.", "question");
          setQuestion(null);
        }
        break;
      case "state":
        updateState(data.state);
        break;
      case "status":
        statusCompletion.textContent = `${data.completionPct ?? 0}%`;
        statusFocus.textContent = data.focus ?? "Waiting...";
        statusPhase.textContent = data.phase ?? "Define";
        statusPhase.classList.remove("muted");
        if (data.hypothesisStats) {
          const h = data.hypothesisStats;
          statusHypotheses.textContent = `${h.total ?? 0} total (${h.accepted ?? 0} accepted, ${h.open ?? 0} open, ${h.rejected ?? 0} rejected)`;
          statusHypotheses.classList.remove("muted");
        } else {
          statusHypotheses.textContent = "0 total";
          statusHypotheses.classList.add("muted");
        }
        if (data.notes && data.notes.length) {
          statusNotes.innerHTML = data.notes.map((n) => `<div>• ${n}</div>`).join("");
          statusNotes.classList.remove("muted");
        } else {
          statusNotes.textContent = "No notes yet.";
          statusNotes.classList.add("muted");
        }
        break;
      case "result":
        appendLog(`Investigator result: ${data.output || "(none)"}`, "result");
        if ((data.output || "").trim() === "READY_FOR_FINAL_RCA") {
          finalBtn.disabled = false;
        }
        break;
      case "ready_for_final":
        finalBtn.disabled = false;
        appendLog("Ready for final RCA generation.", "result");
        break;
      case "final":
        finalView.textContent = data.output || "";
        finalPreview.innerHTML = renderMarkdown(data.output || "");
        appendLog("Final RCA generated.", "result");
        break;
      case "final_delta":
        finalView.textContent += data.delta ?? "";
        finalPreview.innerHTML = renderMarkdown(finalView.textContent);
        break;
      case "error":
        appendLog(`Error: ${data.message}`, "error");
        continueBtn.classList.remove("hidden");
        break;
      default:
        break;
    }
  };
}

startBtn.addEventListener("click", async () => {
  setStatus("Starting...");
  logEl.innerHTML = "";
  finalView.textContent = "";
  setQuestion(null);
  finalBtn.disabled = true;
  evidenceBtn.disabled = false;
  evidenceSection.classList.remove("hidden");
  statusCompletion.textContent = "0%";
  statusFocus.textContent = "Starting investigation...";
  statusPhase.textContent = "Define";
  statusHypotheses.textContent = "0 total";
  statusNotes.textContent = "No notes yet.";
  statusNotes.classList.add("muted");

  const formData = new FormData();
  formData.append("incident", incidentText.value);
  for (const file of incidentFiles.files) {
    formData.append("files", file);
  }

  const res = await fetch("/api/start", {
    method: "POST",
    body: formData
  });
  const data = await res.json();
  sessionId = data.sessionId;
  connectStream(sessionId);
  setStatus(`Session ${sessionId}`);
  incidentSection.classList.add("hidden");
});

answerBtn.addEventListener("click", async () => {
  if (!sessionId) return;
  const answer = answerText.value;
  answerText.value = "";
  setQuestion(null);
  await fetch("/api/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, answer })
  });
});

continueBtn.addEventListener("click", async () => {
  if (!sessionId) return;
  await fetch("/api/continue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });
  continueBtn.classList.add("hidden");
});

finalBtn.addEventListener("click", async () => {
  if (!sessionId) return;
  await fetch("/api/final", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });
});

finalViewTab.addEventListener("click", () => setFinalViewTab("markdown"));
finalPreviewTab.addEventListener("click", () => setFinalViewTab("preview"));
finalFullscreenBtn.addEventListener("click", openFullscreenPreview);

evidenceBtn.addEventListener("click", async () => {
  if (!sessionId || !evidenceFile.files.length) return;
  const notes = evidenceNotes.value;
  const files = Array.from(evidenceFile.files);
  evidenceNotes.value = "";
  evidenceFile.value = "";

  for (const file of files) {
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("notes", notes);
    formData.append("file", file);
    await fetch("/api/evidence", {
      method: "POST",
      body: formData
    });
  }
});

// Initial UI state
setQuestion(null);
evidenceSection.classList.add("hidden");
