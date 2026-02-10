import { afterEach, beforeEach, expect, test, vi } from "vitest";

// We mock node-telegram-bot-api to avoid real network calls and to simulate inbound messages.
const { FakeTelegramBot } = vi.hoisted(() => {
  type OnTextHandler = {
    pattern: RegExp;
    cb: (msg: any, match: RegExpExecArray | null) => unknown;
  };

  type SentMessage = { chatId: number; text: string; options?: any };

  class FakeTelegramBot {
    static instances: FakeTelegramBot[] = [];

    sentMessages: SentMessage[] = [];

    private readonly messageHandlers: Array<(msg: any) => unknown> = [];
    private readonly pollingErrorHandlers: Array<(err: any) => unknown> = [];
    private readonly onTextHandlers: OnTextHandler[] = [];

    constructor(public token: string, public options: any) {
      FakeTelegramBot.instances.push(this);
    }

    onText(pattern: RegExp, cb: (msg: any, match: RegExpExecArray | null) => unknown): void {
      this.onTextHandlers.push({ pattern, cb });
    }

    on(event: string, cb: (payload: any) => unknown): void {
      if (event === "message") {
        this.messageHandlers.push(cb);
      } else if (event === "polling_error") {
        this.pollingErrorHandlers.push(cb);
      }
    }

    async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
      this.sentMessages.push({ chatId, text, options });
    }

    async sendChatAction(): Promise<void> {
      // no-op
    }

    async stopPolling(): Promise<void> {
      // no-op
    }

    async getMe(): Promise<any> {
      return { id: 999, username: "fakebot" };
    }

    async __emitMessage(msg: any): Promise<void> {
      const work: unknown[] = [];
      for (const cb of this.messageHandlers) {
        work.push(cb(msg));
      }
      if (typeof msg?.text === "string") {
        for (const { pattern, cb } of this.onTextHandlers) {
          const match = pattern.exec(msg.text);
          if (match) {
            work.push(cb(msg, match));
          }
        }
      }
      await Promise.all(work.filter((p: any) => p && typeof p.then === "function"));
    }

    // For completeness if tests want to simulate polling errors.
    async __emitPollingError(err: any): Promise<void> {
      const work: unknown[] = [];
      for (const cb of this.pollingErrorHandlers) {
        work.push(cb(err));
      }
      await Promise.all(work.filter((p: any) => p && typeof p.then === "function"));
    }
  }

  return { FakeTelegramBot };
});

vi.mock("node-telegram-bot-api", () => ({ default: FakeTelegramBot }));

import { TelegramClient, type AuthenticatedContext } from "../src/telegram-client";

beforeEach(() => {
  FakeTelegramBot.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

type AuthFlowResult = {
  fromUserId: number;
  accessGranted: boolean;
  commandHandlerCalls: number;
  messageHandlerCalls: number;
  unauthorizedReplies: string[];
  allReplies: string[];
};

const runAuthFlow = async (args: { allowedUsers: number[]; fromUserId: number; username?: string }): Promise<AuthFlowResult> => {
  // Silence auth logs for this test.
  vi.spyOn(console, "log").mockImplementation(() => {});

  const client = new TelegramClient("token", args.allowedUsers);
  const commandHandler = vi.fn(async (_ctx: AuthenticatedContext, _match: RegExpExecArray | null) => {});
  const messageHandler = vi.fn(async (_ctx: AuthenticatedContext) => {});

  client.onCommand(/\/start/, commandHandler);
  client.onMessage(messageHandler);

  const bot = FakeTelegramBot.instances[0];
  expect(bot).toBeTruthy();

  const chat = { id: 10, type: "private" as const };
  const from = { id: args.fromUserId, username: args.username };
  const makeMsg = (text: string) => ({ chat, from, text });

  // Same interaction flow for both scenarios: 1 command + 5 non-command messages.
  const script = ["/start", "hello", "hello", "hello", "hello", "hello"];
  for (const text of script) {
    await bot.__emitMessage(makeMsg(text));
  }

  const allReplies = bot.sentMessages.map((m: any) => String(m?.text ?? ""));
  const unauthorizedReplies = allReplies.filter((text) => /Unauthorized/i.test(text));

  return {
    fromUserId: args.fromUserId,
    accessGranted: commandHandler.mock.calls.length + messageHandler.mock.calls.length > 0,
    commandHandlerCalls: commandHandler.mock.calls.length,
    messageHandlerCalls: messageHandler.mock.calls.length,
    unauthorizedReplies,
    allReplies
  };
};

const expectAuthGateToBehaveConsistently = (result: AuthFlowResult) => {
  // Bot should never "partially allow": either we reject (and reply Unauthorized) without reaching handlers,
  // or we reach handlers without sending Unauthorized replies.
  const reachedHandlers = result.commandHandlerCalls + result.messageHandlerCalls > 0;
  const repliedUnauthorized = result.unauthorizedReplies.length > 0;

  // Rate-limiter / threshold safety.
  expect(result.unauthorizedReplies.length).toBeLessThanOrEqual(5);

  if (repliedUnauthorized) {
    expect(reachedHandlers).toBe(false);
    expect(result.unauthorizedReplies[0]).toMatch(/Unauthorized/i);
    expect(result.unauthorizedReplies[0]).toMatch(new RegExp(String(result.fromUserId)));
    expect(result.unauthorizedReplies[result.unauthorizedReplies.length - 1]).toMatch(/ignored/i);
  } else {
    expect(reachedHandlers).toBe(true);
  }
};

test("unauthorized user is rejected and cannot reach handlers", async () => {
  const result = await runAuthFlow({ allowedUsers: [111], fromUserId: 222, username: "intruder" });
  expectAuthGateToBehaveConsistently(result);
  expect(result.accessGranted).toBe(false);
});

test("authorized user can reach handlers", async () => {
  const result = await runAuthFlow({ allowedUsers: [111], fromUserId: 111, username: "allowed" });
  expectAuthGateToBehaveConsistently(result);
  expect(result.accessGranted).toBe(true);
});
