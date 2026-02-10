import TelegramBot from "node-telegram-bot-api";
import { AcpClient, fetchAgents } from "./acp-client";
import { SessionManager } from "./session-manager";
import { getEffectiveConfig, validateConfig } from "./config";

const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000;

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

const escapeMarkdown = (text: string): string => {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
};

export class TelegramAcpBot {
  private bot: TelegramBot;
  private sessionManager: SessionManager;
  private allowedUsers: Set<number>;
  private availableAgents: Array<{ name: string; command: string; args: string[] }> = [];
  private config: ReturnType<typeof getEffectiveConfig>;
  private typingIntervals = new Map<number, NodeJS.Timeout>();

  constructor() {
    this.config = getEffectiveConfig();
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      throw new Error(`Configuration errors:\n${errors.join("\n")}`);
    }

    this.allowedUsers = new Set(this.config.allowedUsers);
    this.bot = new TelegramBot(this.config.telegramToken, { polling: true });

    this.sessionManager = new SessionManager(
      this.config.defaultAgent,
      (agent: string) => new AcpClient({
        url: this.config.acpRemoteUrl,
        token: this.config.acpRemoteToken,
        agent,
        requestTimeoutMs: this.config.requestTimeoutMs,
        reconnectIntervalMs: this.config.reconnectIntervalMs,
        maxReconnectAttempts: this.config.maxReconnectAttempts,
      })
    );

    this.setupHandlers();
  }

  private isAllowed(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }

  private async sendUnauthorized(chatId: number, userId: number): Promise<void> {
    await this.bot.sendMessage(
      chatId,
      `Unauthorized. Your user ID (${userId}) is not in the allowed list.`
    );
  }

  private startTyping(chatId: number): void {
    this.stopTyping(chatId);
    const sendTyping = () => {
      this.bot.sendChatAction(chatId, "typing").catch(() => {});
    };
    sendTyping();
    const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);
    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: number): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  private async sendLongMessage(chatId: number, text: string, parseMode?: "Markdown" | "HTML"): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(chatId, chunk, { parse_mode: parseMode });
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

  private setupHandlers(): void {
    // /start - Welcome message and help
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      const helpText = `
Welcome to the ACP Telegram Bot!

*Commands:*
/new - Start a new ACP session
/end - End current session
/status - Show current session status
/agents - List available agents
/agent <name> - Select an agent for new sessions
/cancel - Cancel current request
/help - Show this help message

*Usage:*
After starting a session with /new, simply send any message and it will be forwarded to the ACP agent as a prompt.

*Current Configuration:*
Default Agent: ${this.config.defaultAgent || "auto"}
ACP Server: ${this.config.acpRemoteUrl}
      `.trim();

      await this.sendLongMessage(chatId, helpText, "Markdown");
    });

    // /help - Show help
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      const helpText = `
*ACP Telegram Bot Commands:*

/new [cwd] - Start a new session (optional: working directory)
/end - End the current session
/status - Show session info
/agents - List available ACP agents
/agent <name> - Set agent for new sessions
/cancel - Cancel the current request
/help - Show this message

Send any text message to interact with the agent.
      `.trim();

      await this.sendLongMessage(chatId, helpText, "Markdown");
    });

    // /new - Start new session
    this.bot.onText(/\/new(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      const cwd = match?.[1]?.trim();

      try {
        this.startTyping(chatId);
        const session = await this.sessionManager.createSession(userId, chatId, cwd);
        this.stopTyping(chatId);

        await this.bot.sendMessage(
          chatId,
          `Session started!\n\nAgent: ${session.agent}\nSession ID: ${session.sessionId}${session.cwd ? `\nWorking Directory: ${session.cwd}` : ""}\n\nSend a message to start interacting.`
        );
      } catch (err) {
        this.stopTyping(chatId);
        const message = err instanceof Error ? err.message : "Failed to create session";
        await this.bot.sendMessage(chatId, `Failed to start session: ${message}`);
      }
    });

    // /end - End session
    this.bot.onText(/\/end/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      try {
        await this.sessionManager.endSession(userId);
        await this.bot.sendMessage(chatId, "Session ended.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to end session";
        await this.bot.sendMessage(chatId, `Error: ${message}`);
      }
    });

    // /status - Show session status
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      const prefs = this.sessionManager.getPreferences(userId);
      const sessionInfo = this.sessionManager.getSessionInfo(userId);
      const status = `
*User Preferences:*
Selected Agent: ${prefs.selectedAgent || "default"}
${prefs.defaultCwd ? `Default CWD: ${prefs.defaultCwd}` : ""}

*Session Status:*
${sessionInfo}
      `.trim();

      await this.sendLongMessage(chatId, status, "Markdown");
    });

    // /agents - List agents
    this.bot.onText(/\/agents/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      try {
        this.startTyping(chatId);
        const agents = await fetchAgents(this.config.acpRemoteHttpUrl, this.config.acpRemoteToken);
        this.availableAgents = agents;
        this.stopTyping(chatId);

        if (agents.length === 0) {
          await this.bot.sendMessage(chatId, "No agents available.");
          return;
        }

        const prefs = this.sessionManager.getPreferences(userId);
        const agentList = agents.map((a) => {
          const selected = a.name === prefs.selectedAgent ? " (selected)" : "";
          return `- ${a.name}${selected}`;
        }).join("\n");

        await this.bot.sendMessage(
          chatId,
          `*Available Agents:*\n${agentList}\n\nUse /agent <name> to select one.`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        this.stopTyping(chatId);
        const message = err instanceof Error ? err.message : "Failed to fetch agents";
        await this.bot.sendMessage(chatId, `Failed to fetch agents: ${message}`);
      }
    });

    // /agent <name> - Select agent
    this.bot.onText(/\/agent\s+(.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      const agentName = match?.[1]?.trim();
      if (!agentName) {
        await this.bot.sendMessage(chatId, "Please specify an agent name. Use /agents to see available agents.");
        return;
      }

      // Validate agent exists if we have the list
      if (this.availableAgents.length > 0) {
        const exists = this.availableAgents.some((a) => a.name === agentName);
        if (!exists) {
          await this.bot.sendMessage(
            chatId,
            `Agent "${agentName}" not found. Use /agents to see available agents.`
          );
          return;
        }
      }

      this.sessionManager.setSelectedAgent(userId, agentName);
      await this.bot.sendMessage(
        chatId,
        `Agent set to: ${agentName}\n\nThis will be used for new sessions. Use /new to start a session with this agent.`
      );
    });

    // /cancel - Cancel current request
    this.bot.onText(/\/cancel/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        await this.sendUnauthorized(chatId, userId || 0);
        return;
      }

      if (!this.sessionManager.isProcessing(userId)) {
        await this.bot.sendMessage(chatId, "No request is currently being processed.");
        return;
      }

      try {
        await this.sessionManager.cancelCurrentRequest(userId);
        this.stopTyping(chatId);
        await this.bot.sendMessage(chatId, "Request cancelled.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to cancel";
        await this.bot.sendMessage(chatId, `Failed to cancel: ${message}`);
      }
    });

    // Handle regular messages (prompts)
    this.bot.on("message", async (msg) => {
      // Skip commands
      if (msg.text?.startsWith("/")) {
        return;
      }

      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (!userId || !this.isAllowed(userId)) {
        // Don't respond to every unauthorized message
        return;
      }

      const text = msg.text?.trim();
      if (!text) {
        return;
      }

      // Check if there's an active session
      if (!this.sessionManager.hasActiveSession(userId)) {
        await this.bot.sendMessage(
          chatId,
          "No active session. Use /new to start a session first."
        );
        return;
      }

      // Check if already processing
      if (this.sessionManager.isProcessing(userId)) {
        await this.bot.sendMessage(
          chatId,
          "A request is already being processed. Please wait or use /cancel."
        );
        return;
      }

      try {
        this.startTyping(chatId);
        
        // Track notifications for progress updates
        let lastProgressMessage = "";
        const onNotification = (notification: any) => {
          if (notification.method === "remote/progress") {
            const params = notification.params || {};
            const progressMsg = params.message || params.stage || "";
            if (progressMsg && progressMsg !== lastProgressMessage) {
              lastProgressMessage = progressMsg;
              // Don't await, fire and forget
              this.bot.sendMessage(chatId, `[Progress] ${progressMsg}`).catch(() => {});
            }
          }
        };

        const result = await this.sessionManager.sendPrompt(userId, text, onNotification);
        this.stopTyping(chatId);

        // Format and send the response
        let responseText = "";
        
        if (result.stopReason === "cancelled") {
          responseText = "[Request was cancelled]";
        } else if (result.stopReason === "max_tokens") {
          responseText = "[Response truncated due to token limit]";
        } else if (result.stopReason === "refusal") {
          responseText = "[Request was refused by the agent]";
        }

        // Check for target metadata (git commit info)
        if (result._meta?.target) {
          const target = result._meta.target;
          const commitInfo = `\n\n[Committed: ${target.branch} @ ${target.revision.slice(0, 7)}]`;
          responseText = responseText ? responseText + commitInfo : commitInfo;
        }

        if (responseText) {
          await this.sendLongMessage(chatId, responseText);
        } else {
          await this.bot.sendMessage(chatId, "[Done]");
        }

      } catch (err) {
        this.stopTyping(chatId);
        const message = err instanceof Error ? err.message : "Request failed";
        await this.bot.sendMessage(chatId, `Error: ${message}`);
      }
    });

    // Handle errors
    this.bot.on("polling_error", (error) => {
      console.error("Telegram polling error:", error.message);
    });
  }

  async start(): Promise<void> {
    console.log("Starting Telegram ACP Bot...");
    console.log(`Allowed users: ${Array.from(this.allowedUsers).join(", ")}`);
    console.log(`ACP Remote URL: ${this.config.acpRemoteUrl}`);
    console.log(`Default Agent: ${this.config.defaultAgent || "auto"}`);

    // Fetch available agents on startup
    try {
      this.availableAgents = await fetchAgents(this.config.acpRemoteHttpUrl, this.config.acpRemoteToken);
      console.log(`Available agents: ${this.availableAgents.map((a) => a.name).join(", ")}`);
    } catch (err) {
      console.warn("Could not fetch agents on startup:", err instanceof Error ? err.message : err);
    }

    console.log("Bot is running. Press Ctrl+C to stop.");
  }

  async stop(): Promise<void> {
    console.log("Stopping bot...");
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.sessionManager.disconnectAll();
    this.bot.stopPolling();
    console.log("Bot stopped.");
  }
}
