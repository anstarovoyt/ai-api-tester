import TelegramBot, { Message, User } from "node-telegram-bot-api";

const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000;
const UNAUTHORIZED_REPLY_LIMIT = 5;

export type AuthenticatedContext = {
  chatId: number;
  userId: number;
  msg: Message;
};

type CommandHandler = (ctx: AuthenticatedContext, match: RegExpExecArray | null) => Promise<void>;
type MessageHandler = (ctx: AuthenticatedContext) => Promise<void>;

const splitMessage = (text: string, maxLength = MAX_MESSAGE_LENGTH): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try to split at space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Force split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
};

/**
 * Wrapper around TelegramBot that handles authentication and provides
 * a controlled interface for all bot operations.
 */
export class TelegramClient {
  private readonly bot: TelegramBot;
  private readonly allowedUsers: Set<number>;
  private readonly typingIntervals = new Map<number, NodeJS.Timeout>();
  private readonly unauthorizedReplyCount = new Map<string, number>();

  constructor(token: string, allowedUsers: number[]) {
    this.bot = new TelegramBot(token, { polling: true });
    this.allowedUsers = new Set(allowedUsers);
  }

  async getMe(): Promise<User> {
    return await this.bot.getMe();
  }

  private log(message: string, extra?: any): void {
    if (extra !== undefined) {
      console.log(`[TELEGRAM] ${message}`, extra);
    } else {
      console.log(`[TELEGRAM] ${message}`);
    }
  }

  private logWarn(message: string, extra?: any): void {
    if (extra !== undefined) {
      console.log(`[TELEGRAM][WARN] ${message}`, extra);
    } else {
      console.log(`[TELEGRAM][WARN] ${message}`);
    }
  }

  private isAllowed(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }

  /**
   * Authenticate a message and return context if allowed, null otherwise.
   */
  private authenticateMessage(msg: Message, sendUnauthorizedResponse: boolean): AuthenticatedContext | null {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !this.isAllowed(userId)) {
      if (sendUnauthorizedResponse) {
        const username = msg.from?.username;
        const key = userId ? `u:${userId}` : `c:${chatId}`;
        const count = this.unauthorizedReplyCount.get(key) || 0;
        if (count < UNAUTHORIZED_REPLY_LIMIT) {
          const next = count + 1;
          this.unauthorizedReplyCount.set(key, next);
          this.sendMessage(
            chatId,
            `Unauthorized. Your Telegram user ID (${userId || 0}) is not allowed to use this bot.\n\nAsk the bot admin to add it to TELEGRAM_ALLOWED_USERS.${next === UNAUTHORIZED_REPLY_LIMIT ? "\n\nFurther messages will be ignored." : ""}`
          ).catch(() => {});
          this.logWarn(`Unauthorized message rejected: userId: ${userId || 0}${username ? ` username: @${username}` : ""}`);
        }
      }
      return null;
    }

    return { chatId, userId, msg };
  }

  /**
   * Register a command handler with authentication.
   * Unauthorized responses are handled by the generic message handler to avoid duplicate replies.
   */
  onCommand(pattern: RegExp, handler: CommandHandler): void {
    this.bot.onText(pattern, async (msg, match) => {
      // Unauthorized handling is done in the generic message handler to avoid duplicate replies.
      const ctx = this.authenticateMessage(msg, false);
      if (!ctx) return;
      await handler(ctx, match);
    });
  }

  /**
   * Register a message handler with authentication.
   * Replies to unauthorized users a limited number of times, then ignores them.
   */
  onMessage(handler: MessageHandler): void {
    this.bot.on("message", async (msg) => {
      // Always authenticate first so unauthorized users get a response even for unknown commands.
      const ctx = this.authenticateMessage(msg, true);
      if (!ctx) return;

      // Skip commands - they're handled by onCommand
      if (msg.text?.startsWith("/")) {
        return;
      }
      await handler(ctx);
    });
  }

  /**
   * Register a polling error handler.
   */
  onPollingError(handler: (error: Error) => void): void {
    this.bot.on("polling_error", handler);
  }

  /**
   * Send a message to a chat.
   */
  async sendMessage(chatId: number, text: string, parseMode?: "Markdown" | "HTML"): Promise<void> {
    await this.bot.sendMessage(chatId, text, parseMode ? { parse_mode: parseMode } : undefined);
  }

  /**
   * Send a long message, splitting it into chunks if necessary.
   * Falls back to plain text if markdown parsing fails.
   */
  async sendLongMessage(chatId: number, text: string, parseMode?: "Markdown" | "HTML"): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(chatId, chunk, parseMode ? { parse_mode: parseMode } : undefined);
      } catch (err) {
        // If markdown fails, try plain text
        if (parseMode) {
          await this.bot.sendMessage(chatId, chunk);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Start showing typing indicator. Call stopTyping() when done.
   */
  startTyping(chatId: number): void {
    this.stopTyping(chatId);
    const sendTyping = () => {
      this.bot.sendChatAction(chatId, "typing").catch(() => {});
    };
    sendTyping();
    const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);
    this.typingIntervals.set(chatId, interval);
  }

  /**
   * Stop showing typing indicator.
   */
  stopTyping(chatId: number): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  /**
   * Stop polling and clean up resources.
   */
  async stop(): Promise<void> {
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.bot.stopPolling();
  }
}
