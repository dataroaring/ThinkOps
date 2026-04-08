import { loadConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { runCheck } from "./check.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    await runCheck();
    return;
  }

  console.log("[thinkops] loading config...");
  const config = loadConfig();
  console.log(`[thinkops] vault: ${config.vaultPath}`);
  console.log(`[thinkops] agent: ${config.agentCli}/${config.agentModel}`);

  const orchestrator = new Orchestrator(config);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[thinkops] shutting down...");
    orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await orchestrator.start();
  console.log("[thinkops] running. press ctrl+c to stop.");
}

main().catch((err) => {
  console.error("[thinkops] fatal:", err);
  process.exit(1);
});
