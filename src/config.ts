import { z } from "zod";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";

loadEnv();

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

const configSchema = z.object({
  telegramBotToken: z.string().min(1),
  telegramChatId: z.string().min(1),

  vaultPath: z.string().min(1).transform(expandHome),

  agentCli: z.enum(["claude", "opencode"]).default("claude"),
  agentModel: z.string().default("sonnet"),

  taskPollInterval: z.coerce.number().positive().default(30),
  skillExtractInterval: z.coerce.number().positive().default(3600),
  skillOrganizeInterval: z.coerce.number().positive().default(86400),
  knowledgeLintInterval: z.coerce.number().positive().default(86400),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    vaultPath: process.env.VAULT_PATH,
    agentCli: process.env.AGENT_CLI,
    agentModel: process.env.AGENT_MODEL,
    taskPollInterval: process.env.TASK_POLL_INTERVAL,
    skillExtractInterval: process.env.SKILL_EXTRACT_INTERVAL,
    skillOrganizeInterval: process.env.SKILL_ORGANIZE_INTERVAL,
    knowledgeLintInterval: process.env.KNOWLEDGE_LINT_INTERVAL,
  });
}
