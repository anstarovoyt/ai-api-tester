#!/usr/bin/env node

import { runDeployJob } from "./index";
import { createRemoteRunJob } from "./jobs";
import { formatUnknownError, parseCommonDeployCliArgs } from "./cli";

const { remote, skipPassword, skipBuild, customNodePath, scriptName } = parseCommonDeployCliArgs(process.argv, "deploy");

if (!remote) {
  console.error(`Usage: ${scriptName} <user@host> [--no-password] [--node=/path/to/node] [--skip-build]`);
  console.error("");
  console.error("Options:");
  console.error("  --no-password    Use SSH key authentication instead of password");
  console.error("  --node=/path     Specify the path to node on the remote machine");
  console.error("  --skip-build     Skip local TypeScript build step (assumes packages are already built)");
  process.exit(1);
}

async function main() {
  try {
    await runDeployJob(createRemoteRunJob(), {
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
