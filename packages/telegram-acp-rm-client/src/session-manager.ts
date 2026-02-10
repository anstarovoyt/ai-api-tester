import {AcpClient, PromptResult} from "./acp-client";

export type UserSession = {
  sessionId: string;
  chatId: number;
  userId: number;
  agent: string;
  cwd?: string;
  createdAt: number;
  lastActiveAt: number;
  isProcessing: boolean;
};

export type UserPreferences = {
  userId: number;
  selectedAgent: string;
  defaultCwd?: string;
};

export class SessionManager {
  // Sessions are bound to a (userId, chatId) pair to avoid leaking a DM session into a group chat (and vice versa).
  private sessions = new Map<string, UserSession>();
  private preferences = new Map<number, UserPreferences>();
  private acpClients = new Map<string, AcpClient>();
  // A single ACP websocket connection (AcpClient) multiplexes notifications for all requests. To avoid cross-chat/user
  // leakage of progress notifications, only allow one in-flight prompt per client.
  private activePromptClients = new Set<AcpClient>();
  private readonly defaultAgent: string;
  private readonly createClientFn: (agent: string) => AcpClient;

  constructor(defaultAgent: string, createClientFn: (agent: string) => AcpClient) {
    this.defaultAgent = defaultAgent;
    this.createClientFn = createClientFn;
  }

  getPreferences(userId: number): UserPreferences {
    let prefs = this.preferences.get(userId);
    if (!prefs) {
      prefs = {
        userId,
        selectedAgent: this.defaultAgent,
      };
      this.preferences.set(userId, prefs);
    }
    return prefs;
  }

  setSelectedAgent(userId: number, agent: string): void {
    const prefs = this.getPreferences(userId);
    prefs.selectedAgent = agent;
  }
  private getOrCreateClient(agent: string): AcpClient {
    let client = this.acpClients.get(agent);
    if (!client) {
      client = this.createClientFn(agent);
      this.acpClients.set(agent, client);
      client.on("open", () => console.log("[ACP] websocket connected.", { agent }));
      client.on("close", (code: number, reason: string) => console.log("[ACP][WARN] websocket closed.", { agent, code, reason }));
      client.on("reconnecting", (attempt: number) => console.log("[ACP][WARN] websocket reconnecting.", { agent, attempt }));
      client.on("reconnect_failed", () => console.log("[ACP][ERROR] websocket reconnect failed.", { agent }));
      client.on("error", (err: Error) => console.log("[ACP][ERROR] websocket error.", { agent, error: err.message }));
    }
    return client;
  }

  getStateSummary(): { sessions: number; acpClients: number; activePromptClients: number } {
    return {
      sessions: this.sessions.size,
      acpClients: this.acpClients.size,
      activePromptClients: this.activePromptClients.size
    };
  }

  private sessionKey(userId: number, chatId: number): string {
    return `${userId}:${chatId}`;
  }

  private getSession(userId: number, chatId: number): UserSession | undefined {
    return this.sessions.get(this.sessionKey(userId, chatId));
  }

  hasActiveSessionInChat(userId: number, chatId: number): boolean {
    return Boolean(this.getSession(userId, chatId));
  }

  isProcessingInChat(userId: number, chatId: number): boolean {
    const session = this.getSession(userId, chatId);
    return session?.isProcessing ?? false;
  }
  async createSession(userId: number, chatId: number, cwd?: string): Promise<UserSession> {
    // End existing session in this chat first
    await this.endSession(userId, chatId);

    const prefs = this.getPreferences(userId);
    const agent = prefs.selectedAgent || this.defaultAgent;
    const client = this.getOrCreateClient(agent);

    await client.connect();
    const sessionInfo = await client.createSession(cwd || prefs.defaultCwd);

    const session: UserSession = {
      sessionId: sessionInfo.sessionId,
      chatId,
      userId,
      agent,
      cwd: sessionInfo.cwd,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      isProcessing: false,
    };

    this.sessions.set(this.sessionKey(userId, chatId), session);
    return session;
  }

  async sendPrompt(userId: number, chatId: number, prompt: string, onNotification?: (notification: any) => void): Promise<PromptResult> {
    const session = this.getSession(userId, chatId);
    if (!session) {
      throw new Error("No active session. Use /new to start a new session.");
    }

    const client = this.getOrCreateClient(session.agent);
    if (this.activePromptClients.has(client)) {
      throw new Error("Another request is already being processed. Please wait or use /cancel.");
    }
    
    // Set up notification listener if provided
    const notificationHandler = onNotification 
      ? (notification: any) => onNotification(notification)
      : undefined;
    
    if (notificationHandler) {
      client.on("notification", notificationHandler);
    }

    try {
      this.activePromptClients.add(client);
      session.isProcessing = true;
      session.lastActiveAt = Date.now();
      return await client.sendPrompt(session.sessionId, prompt);
    } finally {
      this.activePromptClients.delete(client);
      session.isProcessing = false;
      if (notificationHandler) {
        client.off("notification", notificationHandler);
      }
    }
  }

  async cancelCurrentRequest(userId: number, chatId: number): Promise<void> {
    const session = this.getSession(userId, chatId);
    if (!session) {
      return;
    }

    const client = this.getOrCreateClient(session.agent);
    await client.cancelSession(session.sessionId);
    session.isProcessing = false;
  }

  async endSession(userId: number, chatId: number): Promise<void> {
    const key = this.sessionKey(userId, chatId);
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }

    // Cancel any ongoing request
    if (session.isProcessing) {
      await this.cancelCurrentRequest(userId, chatId);
    }

    this.sessions.delete(key);
  }

  getSessionInfo(userId: number, chatId: number): string {
    const session = this.getSession(userId, chatId);
    if (!session) {
      return "No active session";
    }

    const duration = Math.floor((Date.now() - session.createdAt) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    return [
      `Session ID: ${session.sessionId}`,
      `Agent: ${session.agent}`,
      session.cwd ? `Working Directory: ${session.cwd}` : null,
      `Duration: ${minutes}m ${seconds}s`,
      `Status: ${session.isProcessing ? "Processing..." : "Idle"}`,
    ].filter(Boolean).join("\n");
  }

  async disconnectAll(): Promise<void> {
    for (const [, client] of this.acpClients) {
      client.disconnect();
    }
    this.acpClients.clear();
    this.sessions.clear();
  }
}
