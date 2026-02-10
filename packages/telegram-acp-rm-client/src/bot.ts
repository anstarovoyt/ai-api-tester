import { AcpClient, fetchAgents } from "./acp-client";
import { SessionManager } from "./session-manager";
import { getEffectiveConfig, validateConfig } from "./config";
import { TelegramClient, AuthenticatedContext } from "./telegram-client";

export class TelegramAcpBot {
  private readonly client: TelegramClient;
  private readonly sessionManager: SessionManager;
  private readonly config: ReturnType<typeof getEffectiveConfig>;
  private availableAgents: Array<{ name: string; command: string; args: string[] }> = [];

  constructor() {
    this.config = getEffectiveConfig();
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      throw new Error(`Configuration errors:\n${errors.join("\n")}`);
    }

    this.client = new TelegramClient(this.config.telegramToken, this.config.allowedUsers);

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

  private setupHandlers(): void {
    // /start - Welcome message and help
    this.client.onCommand(/\/start/, async ({ chatId }) => {
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
After starting a session with /new, send any message, and it will be forwarded to the ACP agent as a prompt.

*Current Configuration:*
Default Agent: ${this.config.defaultAgent || "auto"}
ACP Server: ${this.config.acpRemoteUrl}
      `.trim();

      await this.client.sendLongMessage(chatId, helpText, "Markdown");
    });

    // /help - Show help
    this.client.onCommand(/\/help/, async ({ chatId }) => {
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

      await this.client.sendLongMessage(chatId, helpText, "Markdown");
    });

    // /new - Start new session
    this.client.onCommand(/\/new(?:\s+(.+))?/, async ({ chatId, userId }, match) => {
      const cwd = match?.[1]?.trim();

      try {
        this.client.startTyping(chatId);
        const session = await this.sessionManager.createSession(userId, chatId, cwd);
        this.client.stopTyping(chatId);

        await this.client.sendMessage(
          chatId,
          `Session started!\n\nAgent: ${session.agent}\nSession ID: ${session.sessionId}${session.cwd ? `\nWorking Directory: ${session.cwd}` : ""}\n\nSend a message to start interacting.`
        );
      } catch (err) {
        this.client.stopTyping(chatId);
        const message = err instanceof Error ? err.message : "Failed to create session";
        await this.client.sendMessage(chatId, `Failed to start session: ${message}`);
      }
    });

    // /end - End session
    this.client.onCommand(/\/end/, async ({ chatId, userId }) => {
      try {
        await this.sessionManager.endSession(userId);
        await this.client.sendMessage(chatId, "Session ended.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to end session";
        await this.client.sendMessage(chatId, `Error: ${message}`);
      }
    });

    // /status - Show session status
    this.client.onCommand(/\/status/, async ({ chatId, userId }) => {
      const prefs = this.sessionManager.getPreferences(userId);
      const sessionInfo = this.sessionManager.getSessionInfo(userId);
      const status = `
*User Preferences:*
Selected Agent: ${prefs.selectedAgent || "default"}
${prefs.defaultCwd ? `Default CWD: ${prefs.defaultCwd}` : ""}

*Session Status:*
${sessionInfo}
      `.trim();

      await this.client.sendLongMessage(chatId, status, "Markdown");
    });

    // /agents - List agents
    this.client.onCommand(/\/agents/, async ({ chatId, userId }) => {
      try {
        this.client.startTyping(chatId);
        const agents = await fetchAgents(this.config.acpRemoteHttpUrl, this.config.acpRemoteToken);
        this.availableAgents = agents;
        this.client.stopTyping(chatId);

        if (agents.length === 0) {
          await this.client.sendMessage(chatId, "No agents available.");
          return;
        }

        const prefs = this.sessionManager.getPreferences(userId);
        const agentList = agents.map((a) => {
          const selected = a.name === prefs.selectedAgent ? " (selected)" : "";
          return `- ${a.name}${selected}`;
        }).join("\n");

        await this.client.sendMessage(
          chatId,
          `*Available Agents:*\n${agentList}\n\nUse /agent <name> to select one.`,
          "Markdown"
        );
      } catch (err) {
        this.client.stopTyping(chatId);
        const message = err instanceof Error ? err.message : "Failed to fetch agents";
        await this.client.sendMessage(chatId, `Failed to fetch agents: ${message}`);
      }
    });

    // /agent <name> - Select agent
    this.client.onCommand(/\/agent\s+(.+)/, async ({ chatId, userId }, match) => {
      const agentName = match?.[1]?.trim();
      if (!agentName) {
        await this.client.sendMessage(chatId, "Please specify an agent name. Use /agents to see available agents.");
        return;
      }

      // Validate agent exists if we have the list
      if (this.availableAgents.length > 0) {
        const exists = this.availableAgents.some((a) => a.name === agentName);
        if (!exists) {
          await this.client.sendMessage(
            chatId,
            `Agent "${agentName}" not found. Use /agents to see available agents.`
          );
          return;
        }
      }

      this.sessionManager.setSelectedAgent(userId, agentName);
      await this.client.sendMessage(
        chatId,
        `Agent set to: ${agentName}\n\nThis will be used for new sessions. Use /new to start a session with this agent.`
      );
    });

    // /cancel - Cancel current request
    this.client.onCommand(/\/cancel/, async ({ chatId, userId }) => {
      if (!this.sessionManager.isProcessing(userId)) {
        await this.client.sendMessage(chatId, "No request is currently being processed.");
        return;
      }

      try {
        await this.sessionManager.cancelCurrentRequest(userId);
        this.client.stopTyping(chatId);
        await this.client.sendMessage(chatId, "Request cancelled.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to cancel";
        await this.client.sendMessage(chatId, `Failed to cancel: ${message}`);
      }
    });

    // Handle regular messages (prompts)
    this.client.onMessage(async ({ chatId, userId, msg }) => {
      const text = msg.text?.trim();
      if (!text) {
        return;
      }

      // Check if there's an active session
      if (!this.sessionManager.hasActiveSession(userId)) {
        await this.client.sendMessage(
          chatId,
          "No active session. Use /new to start a session first."
        );
        return;
      }

      // Check if already processing
      if (this.sessionManager.isProcessing(userId)) {
        await this.client.sendMessage(
          chatId,
          "A request is already being processed. Please wait or use /cancel."
        );
        return;
      }

      try {
        this.client.startTyping(chatId);
        
        // Track notifications for progress updates
        let lastProgressMessage = "";
        const onNotification = (notification: any) => {
          if (notification.method === "remote/progress") {
            const params = notification.params || {};
            const progressMsg = params.message || params.stage || "";
            if (progressMsg && progressMsg !== lastProgressMessage) {
              lastProgressMessage = progressMsg;
              // Don't await, fire and forget
              this.client.sendMessage(chatId, `[Progress] ${progressMsg}`).catch(() => {});
            }
          }
        };

        const result = await this.sessionManager.sendPrompt(userId, text, onNotification);
        this.client.stopTyping(chatId);

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
          await this.client.sendLongMessage(chatId, responseText);
        } else {
          await this.client.sendMessage(chatId, "[Done]");
        }

      } catch (err) {
        this.client.stopTyping(chatId);
        const message = err instanceof Error ? err.message : "Request failed";
        await this.client.sendMessage(chatId, `Error: ${message}`);
      }
    });

    // Handle errors
    this.client.onPollingError((error) => {
      console.error("Telegram polling error:", error.message);
    });
  }

  async start(): Promise<void> {
    console.log("Starting Telegram ACP Bot...");
    console.log(`Allowed users: ${this.config.allowedUsers.join(", ")}`);
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
    await this.client.stop();
    await this.sessionManager.disconnectAll();
    console.log("Bot stopped.");
  }
}
