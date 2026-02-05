import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as JSON5 from "json5";

export const ACP_CONFIG_PATH = process.env.ACP_CONFIG || path.join(os.homedir(), ".jetbrains", "acp.json");

export const loadAcpConfig = (configPath: string = ACP_CONFIG_PATH): any | null => {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON5.parse(raw);
  } catch {
    return null;
  }
};

export const getAcpAgents = (configPath: string = ACP_CONFIG_PATH): Array<{ name: string; command: string; args: string[] }> | null => {
  const config = loadAcpConfig(configPath);
  if (!config) {
    return null;
  }
  const servers = config.agent_servers || {};
  return Object.entries(servers).map(([name, value]: any) => ({
    name,
    command: value.command,
    args: value.args || []
  }));
};

export const resolveAcpAgentConfig = (
  agentName: string | undefined,
  configPath: string = ACP_CONFIG_PATH
): { name: string; config: any } => {
  const config = loadAcpConfig(configPath);
  if (!config) {
    throw new Error(`ACP config not found: ${configPath}`);
  }
  const servers = config.agent_servers || {};
  const entries = Object.entries(servers);
  if (!entries.length) {
    throw new Error("ACP config does not define any agent_servers");
  }
  if (agentName) {
    const agentConfig = servers[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown ACP agent: ${agentName}`);
    }
    return { name: agentName, config: agentConfig };
  }
  const [defaultName, defaultConfig]: any = entries[0];
  return { name: defaultName, config: defaultConfig };
};

