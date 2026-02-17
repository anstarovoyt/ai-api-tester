import { expect, test } from "vitest";

import { resolveGitRootForRemoteUrl } from "../src/remote-run/git";

test("resolveGitRootForRemoteUrl returns default root when no mapping matches", () => {
  const resolved = resolveGitRootForRemoteUrl("https://github.com/acme/ultimate.git", {
    defaultRoot: { gitRoot: "/default", gitRootSource: "~/git", gitRootSourceLabel: "default" },
    gitRootMap: {},
    gitRootMapSourceLabel: "none",
  });

  expect(resolved.gitRoot).toBe("/default");
  expect(resolved.gitRootSourceLabel).toBe("default");
  expect(resolved.gitRootMapKey).toBeUndefined();
  expect(resolved.gitRootMapMatch).toBeUndefined();
});

test("resolveGitRootForRemoteUrl matches by same repo across ssh/https URLs", () => {
  const resolved = resolveGitRootForRemoteUrl("https://github.com/acme/ultimate.git", {
    defaultRoot: { gitRoot: "/default", gitRootSource: "~/git", gitRootSourceLabel: "default" },
    gitRootMap: {
      "git@github.com:acme/ultimate.git": "/ultimate",
    },
    gitRootMapSourceLabel: "file:acp-remote.json:gitRootMap",
  });

  expect(resolved.gitRoot).toBe("/ultimate");
  expect(resolved.gitRootSourceLabel).toContain("gitRootMap");
  expect(resolved.gitRootMapKey).toBe("git@github.com:acme/ultimate.git");
  expect(resolved.gitRootMapMatch).toBe("sameRepo");
});

test("resolveGitRootForRemoteUrl matches by host/owner/repo key", () => {
  const resolved = resolveGitRootForRemoteUrl("https://github.com/acme/ultimate.git", {
    defaultRoot: { gitRoot: "/default", gitRootSource: "~/git", gitRootSourceLabel: "default" },
    gitRootMap: {
      "github.com/acme/ultimate": "/ultimate",
    },
    gitRootMapSourceLabel: "map",
  });

  expect(resolved.gitRoot).toBe("/ultimate");
  expect(resolved.gitRootMapMatch).toBe("repoId");
});

test("resolveGitRootForRemoteUrl matches by owner/repo key", () => {
  const resolved = resolveGitRootForRemoteUrl("https://github.com/acme/ultimate.git", {
    defaultRoot: { gitRoot: "/default", gitRootSource: "~/git", gitRootSourceLabel: "default" },
    gitRootMap: {
      "acme/ultimate": "/ultimate",
    },
    gitRootMapSourceLabel: "map",
  });

  expect(resolved.gitRoot).toBe("/ultimate");
  expect(resolved.gitRootMapMatch).toBe("repoPath");
});

test("resolveGitRootForRemoteUrl matches by repo name key", () => {
  const resolved = resolveGitRootForRemoteUrl("https://github.com/acme/ultimate.git", {
    defaultRoot: { gitRoot: "/default", gitRootSource: "~/git", gitRootSourceLabel: "default" },
    gitRootMap: {
      ultimate: "/ultimate",
    },
    gitRootMapSourceLabel: "map",
  });

  expect(resolved.gitRoot).toBe("/ultimate");
  expect(resolved.gitRootMapMatch).toBe("repoName");
});

test("resolveGitRootForRemoteUrl prefers more specific mappings over repo name", () => {
  const resolved = resolveGitRootForRemoteUrl("https://github.com/acme/ultimate.git", {
    defaultRoot: { gitRoot: "/default", gitRootSource: "~/git", gitRootSourceLabel: "default" },
    gitRootMap: {
      ultimate: "/by-name",
      "acme/ultimate": "/by-path",
      "github.com/acme/ultimate": "/by-id",
    },
    gitRootMapSourceLabel: "map",
  });

  expect(resolved.gitRoot).toBe("/by-id");
  expect(resolved.gitRootMapMatch).toBe("repoId");
});
