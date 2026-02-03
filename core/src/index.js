import { run, setTracingDisabled } from "@openai/agents";
import { makeInitialState } from "./state.js";
import { evaluateQuality, formatGapsSummary } from "./quality_gates.js";
import { makeCLIIO } from "./io.js";
import { makeInvestigatorAgent, makeFinalWriterAgent } from "./agents.js";

async function main() {
  // For a prototype, keep traces optional (disable if you don't want them):
  // setTracingDisabled(true);

  const io = makeCLIIO();

  try {
    io.log("=== RCA Agent Prototype ===");
    const seed = await io.ask("Paste the incident description (at least a few sentences).");

    const state = makeInitialState(seed);

    // Context object is forwarded to tools; we use it to inject state + IO.
    const ctx = { state, io };

    const investigator = makeInvestigatorAgent();

    // Provide an initial 'user message' that tells the agent to start.
    const initialPrompt = `
Start investigating based on the incident description in ctx.state.
You MUST call evaluate_quality first, then proceed.
`.trim();

    const result = await run(investigator, initialPrompt, {
      context: ctx,
      maxTurns: 200
    });

    io.log("\n=== Investigator result ===");
    io.log(result.finalOutput ?? "(no final output)");

    const quality = evaluateQuality(state);
    io.log(`\nOverall completion: ${quality.overallCompletionPct}%`);
    io.log("\nMandatory gaps summary:");
    io.log(formatGapsSummary(quality));

    if ((result.finalOutput ?? "").trim() !== "READY_FOR_FINAL_RCA") {
      io.log("\nNot ready for final RCA. You can re-run after improving tools/heuristics or increasing maxTurns.");
      return;
    }

    // Final RCA generation
    const finalWriter = makeFinalWriterAgent();
    const finalPrompt = `
Generate the final RCA markdown document using this JSON state:

${JSON.stringify(state, null, 2)}
`.trim();

    const final = await run(finalWriter, finalPrompt, { context: ctx, maxTurns: 6 });

    io.log("\n=== FINAL RCA DOCUMENT (markdown) ===\n");
    io.log(final.finalOutput);

  } finally {
    await io.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
