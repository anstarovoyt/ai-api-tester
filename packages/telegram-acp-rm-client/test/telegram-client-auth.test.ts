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

test("unauthorized user is rejected and cannot reach handlers", async () => {
  // Silence auth logs for this test.
  vi.spyOn(console, "log").mockImplementation(() => {});

  const client = new TelegramClient("token", [111]);

  const commandHandler = vi.fn(async (_ctx: AuthenticatedContext, _match: RegExpExecArray | null) => {});
  const messageHandler = vi.fn(async (_ctx: AuthenticatedContext) => {});

  client.onCommand(/\/start/, commandHandler);
  client.onMessage(messageHandler);

  const bot = FakeTelegramBot.instances[0];
  expect(bot).toBeTruthy();

  const makeMsg = (text: string) => ({
    chat: { id: 10, type: "private" },
    from: { id: 222, username: "intruder" },
    text,
  });

  // 1st message is a command. The wrapper should still reject it (and reply),
  // but must not invoke the command handler.
  await bot.__emitMessage(makeMsg("/start"));

  // Then spam the bot. It should reply 5 times and then go silent.
  for (let i = 0; i < 5; i++) {
    await bot.__emitMessage(makeMsg("hi"));
  }

  expect(commandHandler).not.toHaveBeenCalled();
  expect(messageHandler).not.toHaveBeenCalled();

  // First 5 unauthorized messages get a reply; afterwards the bot ignores the user.
  expect(bot.sentMessages.length).toBe(5);
  expect(bot.sentMessages[0].text).toMatch(/Unauthorized/);
  expect(bot.sentMessages[0].text).toMatch(/222/);
  expect(bot.sentMessages[4].text).toMatch(/Further messages will be ignored/);
});

test("authorized user can reach handlers", async () => {
  // Silence auth logs for this test.
  vi.spyOn(console, "log").mockImplementation(() => {});

  const client = new TelegramClient("token", [111]);

  const commandHandler = vi.fn(async (_ctx: AuthenticatedContext, _match: RegExpExecArray | null) => {});
  const messageHandler = vi.fn(async (_ctx: AuthenticatedContext) => {});

  client.onCommand(/\/start/, commandHandler);
  client.onMessage(messageHandler);

  const bot = FakeTelegramBot.instances[0];
  expect(bot).toBeTruthy();

  const makeMsg = (text: string) => ({
    chat: { id: 10, type: "private" },
    from: { id: 111, username: "allowed" },
    text,
  });

  // Commands should hit onCommand but not onMessage (onMessage skips "/...").
  await bot.__emitMessage(makeMsg("/start"));
  expect(commandHandler).toHaveBeenCalledTimes(1);
  expect(messageHandler).toHaveBeenCalledTimes(0);

  // Normal text should hit onMessage but not onCommand.
  await bot.__emitMessage(makeMsg("hello"));
  expect(messageHandler).toHaveBeenCalledTimes(1);
  expect(commandHandler).toHaveBeenCalledTimes(1);

  // Ensure context is passed through.
  const call = messageHandler.mock.calls[0];
  const ctx = call ? call[0] : undefined;
  expect(ctx).toBeTruthy();
  expect(ctx!.chatId).toBe(10);
  expect(ctx!.userId).toBe(111);

  // No unauthorized messages should be sent.
  expect(bot.sentMessages.length).toBe(0);
});
