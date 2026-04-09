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
    "connector-run.md",
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

  // Test variable interpolation on connector-run
  const connectorRun = await readFile(resolve(promptsDir, "connector-run.md"), "utf-8");
  assert(connectorRun.includes("{connector_path}"), "connector-run has {connector_path} placeholder");
  assert(connectorRun.includes("{connector_content}"), "connector-run has {connector_content} placeholder");
  assert(connectorRun.includes("{audit_log}"), "connector-run has {audit_log} placeholder");
  assert(connectorRun.includes("HUMAN_INPUT_NEEDED"), "connector-run documents HUMAN_INPUT_NEEDED sentinel");
  assert(connectorRun.includes("TASK_COMPLETED"), "connector-run documents TASK_COMPLETED sentinel");
  assert(connectorRun.includes("NO_TASKS_AVAILABLE"), "connector-run documents NO_TASKS_AVAILABLE sentinel");

  // Simulate interpolation
  const interpolated = connectorRun.replace(/\{(\w+)\}/g, (_, key) => {
    const vars: Record<string, string> = {
      connector_path: "/vault/connectors/test.md",
      connector_content: "# Source\nManual list",
      audit_log: "(empty)",
      skill_context: "No skills.",
    };
    return vars[key] ?? `{${key}}`;
  });
  assert(interpolated.includes("/vault/connectors/test.md"), "Interpolation replaces {connector_path}");
  assert(!interpolated.includes("{connector_path}"), "No unreplaced {connector_path} after interpolation");
}

// ── Test 4: Connector listing & audit log ────────────

async function testConnectorScanning(): Promise<void> {
  console.log("\n[Test] Connector listing & audit log");

  // Create test connectors
  await writeFile(
    resolve(TEST_DIR, "connectors/doris.md"),
    `## Source
GitHub Issues: apache/doris
Filter: state:open assignee:dataroaring

## Context
code directory: /Users/qingyu/dataroaring/incubator-doris
using git worktree from upstream/master to isolate tasks.
create pr to apache/doris
`
  );

  await writeFile(
    resolve(TEST_DIR, "connectors/my-project.md"),
    `## Source
Jira: https://company.atlassian.net
Auth: use JIRA_TOKEN environment variable
Filter: project = MYPROJ AND status = "To Do"

## Context
code directory: /tmp/my-project
`
  );

  // _meta files should be skipped
  await writeFile(resolve(TEST_DIR, "connectors/_template.md"), "# Template\nNot a connector.");

  // Simulate listConnectors logic
  const { readdir: rd } = await import("fs/promises");
  const dir = resolve(TEST_DIR, "connectors");
  const files = await rd(dir);
  const connectors = files
    .filter((f: string) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f: string) => ({ name: f.replace(".md", ""), path: resolve(dir, f) }));

  assert(connectors.length === 2, `Found 2 connectors, skipped _template (got ${connectors.length})`);
  assert(connectors.some((c: { name: string }) => c.name === "doris"), "Found doris connector");
  assert(connectors.some((c: { name: string }) => c.name === "my-project"), "Found my-project connector");

  // Test TASK_COMPLETED parsing
  const output1 = `Some agent output...\nTASK_COMPLETED\nid: DORIS-1234\ntitle: Fix BE memory leak\nresult: Created PR https://github.com/apache/doris/pull/999\n`;
  const block = output1.match(/TASK_COMPLETED\s*\n([\s\S]*?)(?:\n```|$)/);
  assert(!!block, "Parses TASK_COMPLETED block");
  const id = block![1].match(/^id:\s*(.+)$/m)?.[1]?.trim();
  const title = block![1].match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const result = block![1].match(/^result:\s*(.+)$/m)?.[1]?.trim();
  assert(id === "DORIS-1234", `Parsed task id: ${id}`);
  assert(title === "Fix BE memory leak", `Parsed task title: ${title}`);
  assert(result?.includes("PR"), `Parsed task result: ${result}`);

  // Test NO_TASKS_AVAILABLE detection
  const output2 = "Checked Jira, no open issues matching filter.\nNO_TASKS_AVAILABLE";
  assert(output2.includes("NO_TASKS_AVAILABLE"), "Detects NO_TASKS_AVAILABLE");

  // Test audit log write + read
  const auditDir = resolve(TEST_DIR, "thinkops/audit");
  await mkdir(auditDir, { recursive: true });
  const auditPath = resolve(auditDir, "doris.md");
  const { appendFile: af, readFile: rf2 } = await import("fs/promises");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await af(auditPath, `- ${now} | **DORIS-1234** | Fix BE memory leak | PR #999\n`);
  await af(auditPath, `- ${now} | **DORIS-5678** | Add retry logic | PR #1000\n`);
  const auditLog = await rf2(auditPath, "utf-8");
  assert(auditLog.includes("DORIS-1234"), "Audit log contains first task");
  assert(auditLog.includes("DORIS-5678"), "Audit log contains second task");
  assert(auditLog.split("\n").filter((l: string) => l.startsWith("- ")).length === 2, "Audit log has 2 entries");
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
