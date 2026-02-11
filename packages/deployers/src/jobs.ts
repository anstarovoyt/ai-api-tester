import * as path from "path";
import { execSync } from "child_process";

import { DeployNodeBundleJob, DeployContext, tailFile } from "./index";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const createServerBuild = (label: string) => ({
  label,
  command: "npm run build:server",
  cwd: REPO_ROOT,
});

const remoteRunHealthCheck = async (ctx: DeployContext): Promise<void> => {
  console.log(`Checking server status from local machine (http://${ctx.remoteHost}:3011/health)...`);
  try {
    const healthCheck = execSync(`curl -s --connect-timeout 5 http://${ctx.remoteHost}:3011/health`, {
      encoding: "utf8",
    });
    console.log(healthCheck.trim());
    return;
  } catch {
    console.log("Server not responding from local machine");
  }

  console.log("\nChecking if server is running on remote...");
  const remoteCheck = await ctx.ssh.execCommand("curl -s http://localhost:3011/health");
  if (remoteCheck.stdout.includes("ok")) {
    console.log("Server IS running on remote (localhost:3011 responds)");
    console.log("But it is NOT reachable from your local machine.");
    console.log("Possible causes:");
    console.log("  - Firewall blocking port 3011");
    console.log("  - Server bound to localhost only");
    console.log("  - Network/routing issue");
    return;
  }

  console.log("Server is not running on remote either.");
  console.log("\nServer log (last 20 lines):");
  console.log(await tailFile(ctx.ssh, ctx.remoteLogPath, 20));
};

export const createRemoteRunJob = (): DeployNodeBundleJob => ({
  name: "server",
  build: createServerBuild("Building server-remote-acp..."),
  bundle: {
    entryFile: path.join(REPO_ROOT, "packages/server-remote-acp/dist/remote-run.js"),
    outfile: path.join(REPO_ROOT, "packages/server-remote-acp/dist-bundle/remote-run.bundle.js"),
    cwd: REPO_ROOT,
  },
  remote: {
    dirName: "scripts/acp-remote",
    bundleFileName: "remote-run.bundle.js",
    logFileName: "server.log",
    stopPattern: "node.*remote-run.bundle.js",
  },
  postStart: remoteRunHealthCheck,
});

export const createTelegramBotJob = ({ configPath }: { configPath: string | null }): DeployNodeBundleJob => {
  return {
    name: "bot",
    build: createServerBuild("Building telegram-acp-rm-client..."),
    bundle: {
      entryFile: path.join(REPO_ROOT, "packages/telegram-acp-rm-client/dist/index.js"),
      outfile: path.join(REPO_ROOT, "packages/telegram-acp-rm-client/dist-bundle/telegram-bot.bundle.js"),
      cwd: REPO_ROOT,
    },
    remote: {
      dirName: "scripts/acp-telegram-bot",
      bundleFileName: "telegram-bot.bundle.js",
      logFileName: "bot.log",
      stopPattern: "node.*telegram-bot.bundle.js",
    },
    uploads: configPath
      ? [
          {
            localPath: configPath,
            remoteFileName: "telegram-bot.json",
            chmod: "600",
            envVar: "BOT_CONFIG_PATH",
          },
        ]
      : [],
  };
};
