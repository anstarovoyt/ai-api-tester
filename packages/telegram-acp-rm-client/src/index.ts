import { TelegramAcpBot } from "./bot";

const main = async () => {
  const bot = new TelegramAcpBot();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down...`);
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await bot.start();
  } catch (err) {
    console.error("Failed to start bot:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
};

main();
