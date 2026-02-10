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
  private sessions = new Map<number, UserSession>();
  private preferences = new Map<number, UserPreferences>();
  private acpClients = new Map<string, AcpClient>();
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
    }
    return client;
  }
  hasActiveSession(userId: number): boolean {
    return this.sessions.has(userId);
  }

  isProcessing(userId: number): boolean {
    const session = this.sessions.get(userId);
    return session?.isProcessing ?? false;
  }
  async createSession(userId: number, chatId: number, cwd?: string): Promise<UserSession> {
    // End existing session first
    await this.endSession(userId);

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

    this.sessions.set(userId, session);
    return session;
  }

  async sendPrompt(userId: number, prompt: string, onNotification?: (notification: any) => void): Promise<PromptResult> {
    const session = this.sessions.get(userId);
    if (!session) {
      throw new Error("No active session. Use /new to start a new session.");
    }

    const client = this.getOrCreateClient(session.agent);
    
    // Set up notification listener if provided
    const notificationHandler = onNotification 
      ? (notification: any) => onNotification(notification)
      : undefined;
    
    if (notificationHandler) {
      client.on("notification", notificationHandler);
    }

    try {
      session.isProcessing = true;
      session.lastActiveAt = Date.now();
      return await client.sendPrompt(session.sessionId, prompt);
    } finally {
      session.isProcessing = false;
      if (notificationHandler) {
        client.off("notification", notificationHandler);
      }
    }
  }

  async cancelCurrentRequest(userId: number): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    const client = this.getOrCreateClient(session.agent);
    await client.cancelSession(session.sessionId);
    session.isProcessing = false;
  }

  async endSession(userId: number): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    // Cancel any ongoing request
    if (session.isProcessing) {
      await this.cancelCurrentRequest(userId);
    }

    this.sessions.delete(userId);
  }

  getSessionInfo(userId: number): string {
    const session = this.sessions.get(userId);
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
