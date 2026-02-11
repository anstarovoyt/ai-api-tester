import { NodeSSH } from "node-ssh";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync } from "child_process";

// readline-sync has no bundled typings; keep it as `any`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rlSync: any = require("readline-sync");

export const DEFAULT_REMOTE_NODE_PATHS = [
  "/opt/homebrew/bin/node", // macOS with Homebrew (Apple Silicon)
  "/usr/local/bin/node", // macOS with Homebrew (Intel) / manual install
  "/usr/bin/node", // Linux system install
  "$HOME/.nvm/versions/node/*/bin/node", // nvm
  "$HOME/.local/bin/node", // user local install
  "$HOME/.volta/bin/node", // volta
  "$HOME/.asdf/shims/node", // asdf
  "/opt/local/bin/node", // MacPorts
] as const;

export const DEFAULT_ESBUILD_EXTERNALS = ["bufferutil", "utf-8-validate"] as const;

export const shQuote = (value: unknown): string => {
  const str = String(value ?? "");
  // Safe single-quote for POSIX shells: ' -> '"'"'
  const escaped = str.replace(/'/g, `'\"'\"'`);
  return `'${escaped}'`;
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type RemoteParts = { username: string; host: string };

export const parseRemote = (remote: string): RemoteParts => {
  if (!remote || typeof remote !== "string") {
    throw new Error("Remote is required");
  }
  const at = remote.indexOf("@");
  if (at <= 0 || at === remote.length - 1) {
    throw new Error("Remote must be in the form user@host");
  }
  return { username: remote.slice(0, at), host: remote.slice(at + 1) };
};

export const promptPassword = (
  remote: string,
  { skipPassword = false }: { skipPassword?: boolean } = {}
): string | null => {
  if (skipPassword) {
    return null;
  }
  const password = rlSync.question(`Enter password for ${remote}: `, { hideEchoBack: true });
  // Keep output consistent with previous deploy scripts.
  console.log();
  return password;
};

export const connectSsh = async ({ remote, password }: { remote: string; password: string | null }): Promise<NodeSSH> => {
  const { username, host } = parseRemote(remote);
  const ssh = new NodeSSH();
  const connectOptions: { host: string; username: string; password?: string } = { host, username };
  if (password) {
    connectOptions.password = password;
  }
  await ssh.connect(connectOptions);
  return ssh;
};

export const getRemoteHome = async (ssh: NodeSSH): Promise<string> => {
  const homeResult = await ssh.execCommand("echo $HOME");
  return homeResult.stdout.trim();
};

export const ensureRemoteDir = async (ssh: NodeSSH, remoteDir: string): Promise<void> => {
  await ssh.execCommand(`mkdir -p ${shQuote(remoteDir)}`);
};

export const stopProcessByPattern = async (ssh: NodeSSH, pattern: string): Promise<void> => {
  await ssh.execCommand(`pkill -f ${shQuote(pattern)} || true`);
};

export const findNodeOnRemote = async (
  ssh: NodeSSH,
  {
    customNodePath = null,
    nodePaths = DEFAULT_REMOTE_NODE_PATHS,
  }: { customNodePath?: string | null; nodePaths?: ReadonlyArray<string> } = {}
): Promise<string | null> => {
  if (customNodePath) {
    return customNodePath;
  }

  for (const nodePath of nodePaths) {
    // Test each path directly; keep glob expansion intact (don't quote nodePath).
    const checkResult = await ssh.execCommand(
      `for p in ${nodePath}; do if [ -x "$p" ]; then echo "$p"; exit 0; fi; done`
    );
    const found = checkResult.stdout.trim();
    if (found) {
      return found;
    }
  }
  return null;
};

export const verifyRemoteNode = async (ssh: NodeSSH, nodeBin: string): Promise<string> => {
  const verifyResult = await ssh.execCommand(`${shQuote(nodeBin)} --version`);
  if (verifyResult.code !== 0) {
    const details = (verifyResult.stderr || verifyResult.stdout || "").trim();
    throw new Error(`Node not executable at: ${nodeBin}${details ? `\n${details}` : ""}`);
  }
  return verifyResult.stdout.trim();
};

export const startNoHup = async (
  ssh: NodeSSH,
  {
    remoteDir,
    nodeBin,
    scriptPath,
    logFilePath,
    env = {},
    args = [],
  }: {
    remoteDir: string;
    nodeBin: string;
    scriptPath: string;
    logFilePath: string;
    env?: Record<string, string>;
    args?: string[];
  }
): Promise<string> => {
  const envPrefix = Object.entries(env)
    .filter(([k]) => Boolean(k))
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(" ");
  const argsStr = args.map(shQuote).join(" ");

  const cmd =
    `cd ${shQuote(remoteDir)} && ` +
    `${envPrefix ? `${envPrefix} ` : ""}` +
    `nohup ${shQuote(nodeBin)} ${shQuote(scriptPath)}${argsStr ? ` ${argsStr}` : ""} ` +
    `> ${shQuote(logFilePath)} 2>&1 & ` +
    "echo $!";

  const startResult = await ssh.execCommand(cmd);
  return startResult.stdout.trim();
};

export const isPidRunning = async (ssh: NodeSSH, pid: string): Promise<boolean> => {
  if (!pid) {
    return false;
  }
  const check = await ssh.execCommand(`kill -0 ${pid} 2>/dev/null && echo ok || echo no`);
  return check.stdout.trim() === "ok";
};

export const tailFile = async (ssh: NodeSSH, filePath: string, lines: number = 20): Promise<string> => {
  const res = await ssh.execCommand(
    `tail -n ${Number(lines) || 20} ${shQuote(filePath)} 2>/dev/null || echo "No log file"`
  );
  return (res.stdout || res.stderr || "").trim();
};

export const bundleWithEsbuild = ({
  entryFile,
  outfile,
  cwd = process.cwd(),
  platform = "node",
  target = "node18",
  format = "cjs",
  externals = [],
}: {
  entryFile: string;
  outfile: string;
  cwd?: string;
  platform?: "node";
  target?: string;
  format?: "cjs" | "esm";
  externals?: string[];
}): { outfile: string; sizeBytes: number } => {
  if (!entryFile || !outfile) {
    throw new Error("bundleWithEsbuild: entryFile and outfile are required");
  }
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Entry file does not exist: ${entryFile}`);
  }

  const outDir = path.dirname(outfile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const args: string[] = [
    "esbuild",
    entryFile,
    "--bundle",
    `--platform=${platform}`,
    `--target=${target}`,
    `--outfile=${outfile}`,
    `--format=${format}`,
  ];

  for (const mod of externals) {
    if (mod) {
      args.push(`--external:${mod}`);
    }
  }

  execFileSync("npx", args, { stdio: "inherit", cwd });

  const stats = fs.statSync(outfile);
  return { outfile, sizeBytes: stats.size };
};

const toRemoteRelativePath = (value: string): string => value.replace(/^\/+/, "");

export type DeployJobBuild = {
  label: string;
  command: string;
  cwd: string;
};

export type DeployJobUpload = {
  localPath: string;
  remoteFileName: string;
  chmod?: string;
  envVar?: string;
};

export type DeployNodeBundleJob = {
  name: string;
  build?: DeployJobBuild;
  bundle: {
    entryFile: string;
    outfile: string;
    cwd: string;
    externals?: string[];
  };
  remote: {
    dirName: string; // relative to $HOME
    bundleFileName: string;
    logFileName: string;
    stopPattern: string;
  };
  uploads?: DeployJobUpload[];
  env?: Record<string, string>;
  waitMs?: number;
  postStart?: (ctx: DeployContext) => Promise<void>;
};

export type DeployCliOptions = {
  remote: string;
  skipPassword?: boolean;
  customNodePath?: string | null;
  skipBuild?: boolean;
  scriptName?: string;
};

export type DeployContext = {
  ssh: NodeSSH;
  remote: string;
  remoteHost: string;
  remoteHome: string;
  remoteDir: string;
  remoteBundlePath: string;
  remoteLogPath: string;
  nodeBin: string;
  nodeVersion: string;
  pid: string;
};

export const runDeployJob = async (job: DeployNodeBundleJob, cli: DeployCliOptions): Promise<DeployContext> => {
  const scriptName = cli.scriptName || path.basename(process.argv[1] || "deploy");
  const skipBuild = Boolean(cli.skipBuild);
  const skipPassword = Boolean(cli.skipPassword);

  if (!skipBuild && job.build) {
    console.log(job.build.label);
    try {
      execSync(job.build.command, { stdio: "inherit", cwd: job.build.cwd });
    } catch {
      throw new Error("TypeScript build failed");
    }
  }

  console.log("Bundling with esbuild...");
  const { sizeBytes } = bundleWithEsbuild({
    entryFile: job.bundle.entryFile,
    outfile: job.bundle.outfile,
    cwd: job.bundle.cwd,
    externals: job.bundle.externals || Array.from(DEFAULT_ESBUILD_EXTERNALS),
  });
  console.log(`Bundle created: ${job.bundle.outfile}`);
  console.log(`Bundle size: ${(sizeBytes / 1024).toFixed(1)} KB`);

  const password = promptPassword(cli.remote, { skipPassword });

  console.log("Connecting to remote...");
  const ssh = await connectSsh({ remote: cli.remote, password });
  console.log("Connected successfully");

  try {
    const { host: remoteHost } = parseRemote(cli.remote);
    const remoteHome = await getRemoteHome(ssh);
    const remoteDir = path.posix.join(remoteHome, toRemoteRelativePath(job.remote.dirName));
    const remoteBundlePath = path.posix.join(remoteDir, toRemoteRelativePath(job.remote.bundleFileName));
    const remoteLogPath = path.posix.join(remoteDir, toRemoteRelativePath(job.remote.logFileName));

    console.log(`Remote directory: ${remoteDir}`);

    console.log("Creating remote directory structure...");
    await ensureRemoteDir(ssh, remoteDir);

    console.log(`Stopping any existing ${job.name}...`);
    await stopProcessByPattern(ssh, job.remote.stopPattern);

    console.log("Copying bundled file to remote...");
    await ssh.putFile(job.bundle.outfile, remoteBundlePath);

    const env: Record<string, string> = { ...(job.env || {}) };

    if (job.uploads && job.uploads.length > 0) {
      for (const upload of job.uploads) {
        const remotePath = path.posix.join(remoteDir, toRemoteRelativePath(upload.remoteFileName));
        const remoteParent = path.posix.dirname(remotePath);
        await ensureRemoteDir(ssh, remoteParent);
        await ssh.putFile(upload.localPath, remotePath);
        if (upload.chmod) {
          await ssh.execCommand(`chmod ${upload.chmod} ${shQuote(remotePath)} || true`);
        }
        if (upload.envVar) {
          env[upload.envVar] = remotePath;
          console.log(`Using ${upload.envVar}=${remotePath}`);
        }
      }
    }

    console.log("Finding node on remote...");
    const nodeBin = await findNodeOnRemote(ssh, { customNodePath: cli.customNodePath || null });
    if (!nodeBin) {
      const message = [
        "Error: Node.js not found on remote machine.",
        "Checked locations:",
        "  - /opt/homebrew/bin/node (macOS Homebrew Apple Silicon)",
        "  - /usr/local/bin/node (macOS Homebrew Intel / manual)",
        "  - /usr/bin/node (Linux system)",
        "  - ~/.nvm/versions/node/*/bin/node (nvm)",
        "  - ~/.volta/bin/node (volta)",
        "  - ~/.asdf/shims/node (asdf)",
        "",
        `Please specify the node path manually: ${scriptName} user@host --node=/path/to/node`,
      ].join("\n");
      throw new Error(message);
    }

    const nodeVersion = await verifyRemoteNode(ssh, nodeBin);
    console.log(`Using node: ${nodeBin} (${nodeVersion})`);

    console.log(`Starting ${job.name} on remote...`);
    const pid = await startNoHup(ssh, {
      remoteDir,
      nodeBin,
      scriptPath: remoteBundlePath,
      logFilePath: remoteLogPath,
      env,
    });

    if (pid) {
      console.log(`Started with PID: ${pid}`);
    }

    console.log("Waiting for process to start...");
    await sleep(job.waitMs ?? 2000);

    if (pid && !(await isPidRunning(ssh, pid))) {
      const tail = await tailFile(ssh, remoteLogPath, 40);
      throw new Error(`Process exited shortly after start.\n\nLog (last 40 lines):\n${tail}`);
    }

    const ctx: DeployContext = {
      ssh,
      remote: cli.remote,
      remoteHost,
      remoteHome,
      remoteDir,
      remoteBundlePath,
      remoteLogPath,
      nodeBin,
      nodeVersion,
      pid,
    };

    if (job.postStart) {
      try {
        await job.postStart(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const tail = await tailFile(ssh, remoteLogPath, 40);
        throw new Error(`${message}\n\nLog (last 40 lines):\n${tail}`);
      }
    }

    console.log("\nDeployment complete!");
    console.log(`${job.name} is running on remote machine.`);
    console.log(`Logs are available at: ${remoteLogPath}`);

    return ctx;
  } finally {
    ssh.dispose();
  }
};
