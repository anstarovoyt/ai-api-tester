import type { WebSocket } from "ws";
import { ACP_REMOTE_SESSION_IDLE_TTL_MS } from "./config";
import { cleanupWorkspace, type GitWorkspaceContext, type RemoteGitInfo } from "./git";
import { logDebug, logError } from "./logger";
import type { AcpAgentRuntime } from "./agent";

export type RemoteRunSessionRecord = {
  sessionId: string;
  runtime: AcpAgentRuntime;
  runId?: string;
  remote?: RemoteGitInfo;
  workspace?: GitWorkspaceContext;
  createdAt: number;
  lastActiveAt: number;
  subscribers: Set<WebSocket>;
  cleanupTimer: NodeJS.Timeout | null;
};

export class RemoteRunSessionManager {
  private sessions = new Map<string, RemoteRunSessionRecord>();
  private runtimeSessionIds = new Map<string, Set<string>>();
  private wsSessionIds = new WeakMap<WebSocket, Set<string>>();

  hasSessionsForRuntime(runtimeId: string): boolean {
    const set = this.runtimeSessionIds.get(runtimeId);
    return Boolean(set && set.size > 0);
  }

  get(sessionId: string): RemoteRunSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  ensure(sessionId: string, runtime: AcpAgentRuntime): RemoteRunSessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.runtime !== runtime) {
        existing.runtime = runtime;
      }
      return existing;
    }
    const record: RemoteRunSessionRecord = {
      sessionId,
      runtime,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      subscribers: new Set(),
      cleanupTimer: null
    };
    this.sessions.set(sessionId, record);
    const key = runtime.id;
    const set = this.runtimeSessionIds.get(key) || new Set<string>();
    set.add(sessionId);
    this.runtimeSessionIds.set(key, set);
    return record;
  }

  setGitContext(sessionId: string, data: { runId: string; remote: RemoteGitInfo; workspace: GitWorkspaceContext }) {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    record.runId = data.runId;
    record.remote = data.remote;
    record.workspace = data.workspace;
  }

  touch(sessionId: string) {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    record.lastActiveAt = Date.now();
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
      record.cleanupTimer = null;
    }
  }

  attach(sessionId: string, ws: WebSocket) {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
      record.cleanupTimer = null;
    }
    record.subscribers.add(ws);
    const current = this.wsSessionIds.get(ws) || new Set<string>();
    current.add(sessionId);
    this.wsSessionIds.set(ws, current);
  }

  detach(ws: WebSocket) {
    const sessionIds = this.wsSessionIds.get(ws);
    if (!sessionIds) {
      return;
    }
    for (const sessionId of sessionIds) {
      const record = this.sessions.get(sessionId);
      if (!record) {
        continue;
      }
      record.subscribers.delete(ws);
      if (record.subscribers.size === 0) {
        this.scheduleCleanup(record);
      }
    }
    sessionIds.clear();
  }

  getSubscribers(sessionId: string): ReadonlySet<WebSocket> {
    return this.sessions.get(sessionId)?.subscribers || new Set();
  }

  private scheduleCleanup(record: RemoteRunSessionRecord) {
    if (record.cleanupTimer || record.subscribers.size > 0) {
      return;
    }
    const ttlMs = ACP_REMOTE_SESSION_IDLE_TTL_MS;
    logDebug("Scheduling session cleanup.", { sessionId: record.sessionId, ttlMs });
    record.cleanupTimer = setTimeout(() => {
      record.cleanupTimer = null;
      void this.expire(record.sessionId);
    }, ttlMs);
    record.cleanupTimer.unref?.();
  }

  private async expire(sessionId: string) {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    if (record.subscribers.size > 0) {
      return;
    }
    logDebug("Expiring session.", { sessionId });
    this.sessions.delete(sessionId);
    const runtimeKey = record.runtime.id;
    const set = this.runtimeSessionIds.get(runtimeKey);
    if (set) {
      set.delete(sessionId);
      if (set.size === 0) {
        this.runtimeSessionIds.delete(runtimeKey);
        try {
          record.runtime.stop();
        } catch {
          // ignore
        }
      }
    }
    if (record.workspace) {
      try {
        await cleanupWorkspace(record.workspace);
      } catch (err) {
        logError("Failed to cleanup git workspace.", { sessionId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
