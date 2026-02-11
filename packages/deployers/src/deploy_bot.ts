#!/usr/bin/env node

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import { runDeployJob } from "./index";
import { createTelegramBotJob } from "./jobs";
import { formatUnknownError, getArgValue, parseCommonDeployCliArgs } from "./cli";

const { args, remote, skipPassword, skipBuild, customNodePath, scriptName } = parseCommonDeployCliArgs(
  process.argv,
  "deploy_bot"
);
const localConfigPathRaw = getArgValue(args, "--config=");

if (!remote) {
  console.error(
    `Usage: ${scriptName} <user@host> [--no-password] [--node=/path/to/node] [--config=/path/to/telegram-bot.json] [--skip-build]`
  );
  console.error("");
  console.error("Options:");
  console.error("  --no-password     Use SSH key authentication instead of password");
  console.error("  --node=/path      Specify the path to node on the remote machine");
  console.error("  --config=/path    Upload a bot config JSON/JSON5 file and run with BOT_CONFIG_PATH");
  console.error("  --skip-build      Skip local TypeScript build step (assumes packages are already built)");
  process.exit(1);
}

const resolveHomePath = (value: string): string => {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

const localConfigPath = localConfigPathRaw
  ? path.resolve(process.cwd(), resolveHomePath(localConfigPathRaw))
  : null;

async function main() {
  if (localConfigPath && !fs.existsSync(localConfigPath)) {
    console.error(`Config file not found: ${localConfigPath}`);
    process.exit(1);
  }

  try {
    await runDeployJob(createTelegramBotJob({ configPath: localConfigPath }), {
      remote,
      skipPassword,
      customNodePath,
      skipBuild,
      scriptName,
    });
  } catch (err) {
    console.error("Deployment failed:", formatUnknownError(err));
    process.exitCode = 1;
  }
}

main();
