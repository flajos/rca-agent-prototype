import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export function makeCLIIO() {
  const rl = readline.createInterface({ input, output });

  return {
    async ask(prompt) {
      const ans = await rl.question(`\n[USER INPUT NEEDED] ${prompt}\n> `);
      return (ans ?? "").trim();
    },
    async close() {
      await rl.close();
    },
    log(msg) {
      output.write(`${msg}\n`);
    }
  };
}
