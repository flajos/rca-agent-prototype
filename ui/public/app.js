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
const evidenceFile = document.getElementById("evidenceFile");
const evidenceNotes = document.getElementById("evidenceNotes");
const evidenceBtn = document.getElementById("evidenceBtn");
const incidentSection = document.getElementById("incidentSection");
const questionSection = document.getElementById("questionSection");
const evidenceSection = document.getElementById("evidenceSection");

let sessionId = null;
let eventSource = null;

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
    return;
  }
  questionBox.textContent = question.prompt;
  questionBox.classList.remove("muted");
  answerBtn.disabled = false;
  questionSection.classList.remove("hidden");
}

function updateState(state) {
  stateView.textContent = JSON.stringify(state, null, 2);
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
        appendLog("Agent asked a question.", "question");
        setQuestion(data.question);
        break;
      case "state":
        updateState(data.state);
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
        appendLog("Final RCA generated.", "result");
        break;
      case "error":
        appendLog(`Error: ${data.message}`, "error");
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

finalBtn.addEventListener("click", async () => {
  if (!sessionId) return;
  await fetch("/api/final", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });
});

evidenceBtn.addEventListener("click", async () => {
  if (!sessionId || !evidenceFile.files.length) return;
  const formData = new FormData();
  formData.append("sessionId", sessionId);
  formData.append("notes", evidenceNotes.value);
  formData.append("file", evidenceFile.files[0]);
  evidenceNotes.value = "";
  evidenceFile.value = "";
  await fetch("/api/evidence", {
    method: "POST",
    body: formData
  });
});

// Initial UI state
setQuestion(null);
evidenceSection.classList.add("hidden");
