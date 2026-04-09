import { readFile, writeFile, mkdir, rm, readdir } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

const TEST_DIR = resolve(tmpdir(), `thinkops-test-${Date.now()}`);
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function setup(): Promise<void> {
  await mkdir(resolve(TEST_DIR, "connectors"), { recursive: true });
  await mkdir(resolve(TEST_DIR, "knowledge/sources"), { recursive: true });
  await mkdir(resolve(TEST_DIR, "skills"), { recursive: true });
  await mkdir(resolve(TEST_DIR, "thinkops"), { recursive: true });
}

// ── Test 1: Config validation ────────────────────────

async function testConfig(): Promise<void> {
  console.log("\n[Test] Config validation");

  const { z } = await import("zod");

  // Missing required fields should fail
  const configSchema = (await import("../src/config.js")).loadConfig;
  try {
    // loadConfig reads process.env which is empty for these fields
    // We test the schema directly
    const schema = z.object({
      telegramBotToken: z.string().min(1),
      telegramChatId: z.string().min(1),
      vaultPath: z.string().min(1),
    });

    let threw = false;
    try {
      schema.parse({});
    } catch {
      threw = true;
    }
    assert(threw, "Rejects missing required fields");

    const result = schema.parse({
      telegramBotToken: "test-token",
      telegramChatId: "12345",
      vaultPath: "/tmp/vault",
    });
    assert(result.telegramBotToken === "test-token", "Parses valid config");
  } catch (err) {
    assert(false, `Config test error: ${err}`);
  }
}

// ── Test 2: Run logger ───────────────────────────────

async function testRunLogger(): Promise<void> {
  console.log("\n[Test] Run logger");

  const { appendRunLog } = await import("../src/utils/run-logger.js");

  await appendRunLog(TEST_DIR, {
    template: "task-executor",
    agent: "claude",
    model: "sonnet",
    elapsed: "5.2s",
    cost: 0.0234,
    turns: 5,
    sessionId: "test-session-123",
    humanInputNeeded: false,
  });

  const logPath = resolve(TEST_DIR, "thinkops/_run_log.md");
  const content = await readFile(logPath, "utf-8");

  assert(content.includes("task-executor"), "Log contains template name");
  assert(content.includes("claude/sonnet"), "Log contains agent/model");
  assert(content.includes("$0.0234"), "Log contains cost");
  assert(content.includes("turns: 5"), "Log contains turn count");
  assert(!content.includes("HUMAN INPUT"), "No human input flag when false");

  // Test with human input needed
  await appendRunLog(TEST_DIR, {
    template: "task-executor",
    agent: "claude",
    model: "sonnet",
    elapsed: "3.1s",
    sessionId: "test-session-456",
    humanInputNeeded: true,
  });

  const content2 = await readFile(logPath, "utf-8");
  assert(content2.includes("**HUMAN INPUT NEEDED**"), "Human input flag when true");
}

// ── Test 3: Template loading ─────────────────────────

async function testTemplates(): Promise<void> {
  console.log("\n[Test] Prompt templates");

  const promptsDir = resolve(import.meta.dirname!, "../prompts");
  const files = await readdir(promptsDir);

  const expectedTemplates = [
    "task-executor.md",
    "knowledge-ingest.md",
    "knowledge-query.md",
    "knowledge-lint.md",
    "skill-extract.md",
    "skill-organize.md",
    "skill-select.md",
  ];

  for (const tmpl of expectedTemplates) {
    assert(files.includes(tmpl), `Template exists: ${tmpl}`);
  }

  // Test variable interpolation
  const taskExecutor = await readFile(resolve(promptsDir, "task-executor.md"), "utf-8");
  assert(taskExecutor.includes("{task_path}"), "task-executor has {task_path} placeholder");
  assert(taskExecutor.includes("{task_content}"), "task-executor has {task_content} placeholder");
  assert(taskExecutor.includes("HUMAN_INPUT_NEEDED"), "task-executor documents HUMAN_INPUT_NEEDED sentinel");

  // Simulate interpolation
  const interpolated = taskExecutor.replace(/\{(\w+)\}/g, (_, key) => {
    const vars: Record<string, string> = {
      task_path: "/vault/tasks/test.md",
      vault_path: "/vault",
      skill_context: "No skills.",
    };
    return vars[key] ?? `{${key}}`;
  });
  assert(interpolated.includes("/vault/tasks/test.md"), "Interpolation replaces {task_path}");
  assert(!interpolated.includes("{task_path}"), "No unreplaced {task_path} after interpolation");
}

// ── Test 4: Connector scanning & cost sorting ────────

async function testConnectorScanning(): Promise<void> {
  console.log("\n[Test] Connector scanning & cost-first sorting");

  // Create test connectors with different costs and pending tasks
  await writeFile(
    resolve(TEST_DIR, "connectors/expensive-project.md"),
    `---
estimated_cost: 0.50
---
# Context
code directory: /tmp/expensive

# tasks
- [ ] Do something costly
- [ ] Another expensive task

# Progress log
- 2026-04-08: Created
`
  );

  await writeFile(
    resolve(TEST_DIR, "connectors/cheap-project.md"),
    `---
estimated_cost: 0.02
---
# Context
code directory: /tmp/cheap

# tasks
- [ ] Do something simple

# Progress log
- 2026-04-08: Created
`
  );

  await writeFile(
    resolve(TEST_DIR, "connectors/no-cost-project.md"),
    `# Context
code directory: /tmp/unknown

# tasks
- [ ] Unknown cost task

# Progress log
- 2026-04-08: Created
`
  );

  await writeFile(
    resolve(TEST_DIR, "connectors/done-project.md"),
    `# Context
code directory: /tmp/done

# tasks
- [x] Already finished task

# Progress log
- 2026-04-07: Completed
`
  );

  // Simulate scanConnectors logic from orchestrator
  const { readdir: rd, readFile: rf } = await import("fs/promises");
  const dir = resolve(TEST_DIR, "connectors");
  const files = await rd(dir);

  interface ConnectorInfo {
    name: string;
    pendingCount: number;
    estimatedCost: number;
  }

  const connectors: ConnectorInfo[] = [];
  for (const f of files) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const content = await rf(resolve(dir, f), "utf-8");
    const pendingMatches = content.match(/- \[ \]/g) || [];
    const costMatch = content.match(/^estimated_cost:\s*(.+)$/m);
    connectors.push({
      name: f.replace(".md", ""),
      pendingCount: pendingMatches.length,
      estimatedCost: costMatch ? parseFloat(costMatch[1]) : Infinity,
    });
  }

  assert(connectors.length === 4, `Found 4 connectors (got ${connectors.length})`);

  const withPending = connectors
    .filter((c) => c.pendingCount > 0)
    .sort((a, b) => a.estimatedCost - b.estimatedCost);

  assert(withPending.length === 3, `3 connectors with pending tasks (got ${withPending.length})`);
  assert(withPending[0].name === "cheap-project", `Cheapest first: ${withPending[0].name}`);
  assert(withPending[1].name === "expensive-project", `Expensive second: ${withPending[1].name}`);
  assert(withPending[2].name === "no-cost-project", `No-cost last: ${withPending[2].name}`);
  assert(withPending[2].estimatedCost === Infinity, "Missing cost defaults to Infinity");

  // Verify pending task extraction
  const expensive = connectors.find((c) => c.name === "expensive-project")!;
  assert(expensive.pendingCount === 2, `Expensive has 2 pending (got ${expensive.pendingCount})`);
  const done = connectors.find((c) => c.name === "done-project")!;
  assert(done.pendingCount === 0, `Done has 0 pending (got ${done.pendingCount})`);
}

// ── Test 5: CLI adapter types ────────────────────────

async function testAgentTypes(): Promise<void> {
  console.log("\n[Test] Agent CLI types");

  const { claudeCli } = await import("../src/agent/claude-cli.js");
  const { opencodeCli } = await import("../src/agent/opencode-cli.js");

  assert(claudeCli.name === "claude", "Claude adapter name is 'claude'");
  assert(opencodeCli.name === "opencode", "OpenCode adapter name is 'opencode'");
  assert(typeof claudeCli.execute === "function", "Claude has execute()");
  assert(typeof claudeCli.resume === "function", "Claude has resume()");
  assert(typeof opencodeCli.execute === "function", "OpenCode has execute()");
  assert(typeof opencodeCli.resume === "function", "OpenCode has resume()");
}

// ── Test 6: Vault template files ─────────────────────

async function testVaultTemplates(): Promise<void> {
  console.log("\n[Test] Vault templates");

  const templatesDir = resolve(import.meta.dirname!, "../templates");
  const knowledgeSchema = await readFile(resolve(templatesDir, "knowledge-schema.md"), "utf-8");
  const skillSchema = await readFile(resolve(templatesDir, "skill-schema.md"), "utf-8");
  const connectorExample = await readFile(resolve(templatesDir, "connector-example.md"), "utf-8");

  assert(knowledgeSchema.includes("Entity Pages"), "Knowledge schema documents entity pages");
  assert(knowledgeSchema.includes("Topic Pages"), "Knowledge schema documents topic pages");
  assert(knowledgeSchema.includes("_index.md"), "Knowledge schema references _index.md");

  assert(skillSchema.includes("domain:"), "Skill schema documents domain field");
  assert(skillSchema.includes("Anti-patterns"), "Skill schema includes anti-patterns section");
  assert(skillSchema.includes("_tree.md"), "Skill schema references _tree.md");

  assert(connectorExample.includes("# Context"), "Connector example has Context section");
  assert(connectorExample.includes("code directory:"), "Connector example has code directory");
  assert(connectorExample.includes("- [ ]"), "Connector example has pending tasks");
}

// ── Run all tests ────────────────────────────────────

async function main(): Promise<void> {
  console.log("ThinkOps Smoke Tests");
  console.log("====================");

  await setup();

  await testConfig();
  await testRunLogger();
  await testTemplates();
  await testConnectorScanning();
  await testAgentTypes();
  await testVaultTemplates();

  // Cleanup
  await rm(TEST_DIR, { recursive: true, force: true });

  console.log(`\n──────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`──────────────────────`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
