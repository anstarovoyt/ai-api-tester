import * as path from "path";

export const getArgValue = (args: string[], prefix: string): string | null => {
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
};

export type CommonDeployCliArgs = {
  args: string[];
  scriptName: string;
  remote: string | null;
  skipPassword: boolean;
  skipBuild: boolean;
  customNodePath: string | null;
};

export const parseCommonDeployCliArgs = (argv: string[], fallbackScriptName: string): CommonDeployCliArgs => {
  const args = argv.slice(2);
  return {
    args,
    scriptName: path.basename(argv[1] || fallbackScriptName),
    remote: args.find((a) => !a.startsWith("--")) || null,
    skipPassword: args.includes("--no-password"),
    skipBuild: args.includes("--skip-build"),
    customNodePath: getArgValue(args, "--node="),
  };
};

export const formatUnknownError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

