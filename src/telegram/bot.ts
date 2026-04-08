import { Telegraf } from "telegraf";
import type { Config } from "../config.js";

type QuestionResolver = (answer: string) => void;

export class TelegramBot {
  private bot: Telegraf;
  private chatId: string;
  private pendingQuestion: QuestionResolver | null = null;

  constructor(private config: Config) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.chatId = config.telegramChatId;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // When a text message arrives and we have a pending question, resolve it
    this.bot.on("text", (ctx) => {
      if (String(ctx.chat.id) !== this.chatId) return;

      if (this.pendingQuestion) {
        const resolve = this.pendingQuestion;
        this.pendingQuestion = null;
        resolve(ctx.message.text);
        return;
      }
    });
  }

  /** Register command handlers. Call this before start(). */
  onCommand(
    command: string,
    handler: (args: string) => Promise<string>
  ): void {
    this.bot.command(command, async (ctx) => {
      if (String(ctx.chat.id) !== this.chatId) return;
      const args = ctx.message.text.replace(`/${command}`, "").trim();
      try {
        const result = await handler(args);
        await ctx.reply(truncate(result));
      } catch (err) {
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** Send a question and wait for the user's reply */
  async askQuestion(question: string, timeoutMs = 3600_000): Promise<string> {
    await this.bot.telegram.sendMessage(
      this.chatId,
      `🤔 **Agent needs input:**\n\n${question}`,
      { parse_mode: "Markdown" }
    );

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingQuestion = null;
        reject(new Error("Question timed out after " + (timeoutMs / 1000) + "s"));
      }, timeoutMs);

      this.pendingQuestion = (answer: string) => {
        clearTimeout(timer);
        resolve(answer);
      };
    });
  }

  /** Send a notification (no reply expected) */
  async notify(message: string): Promise<void> {
    await this.bot.telegram.sendMessage(
      this.chatId,
      truncate(message),
      { parse_mode: "Markdown" }
    );
  }

  async start(): Promise<void> {
    await this.bot.launch();
    console.log("[telegram] bot started");
  }

  stop(): void {
    this.bot.stop("shutdown");
  }
}

function truncate(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 20) + "\n\n...(truncated)";
}
