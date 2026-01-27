# Remote Run Server Implementation Guide

## This is work in progress, this means there are bugs and some things can change. We're ready to discuss any feedback you have

This guide explains how third-party agent vendors can implement a remote run server that integrates with IntelliJ IDEA's ACP (Agent Client Protocol) remote execution feature.

## Overview

Remote run allows an agent to execute on a remote server instead of locally on the user's machine. The IDE connects to your server via WebSocket, sends git repository information, and expects changes to be pushed to a branch that can be merged back into the user's working tree.

**Key flow:**

1. User configures your remote agent in `~/.jetbrains/acp.json`  
2. IDE establishes WebSocket connection to your server  
3. IDE sends `session/new` with current git info  
4. Your server clones/pulls the repo, does the work, pushes to a new branch  
5. Your server responds with target branch info  
6. IDE fetches the remote branch automatically and allows user to merge it

## Configuration: acp.json

Users configure remote agents in `~/.jetbrains/acp.json` under the `remote` section:

```json
{
  "remote": {
    "Your Agent Name": {
      "url": "wss://your-server.example.com/acp",
      "token": "user-auth-token-here"
    }
  }
}
```

### Configuration Fields

| Field | Type | Required | Description |
| :---- | :---- | :---- | :---- |
| `url` | string | Yes | WebSocket URL of your remote agent server |
| `token` | string | No | Authentication token passed in `Authorization` header |

### Example with multiple agents

```json
{
  "agent_servers": {
    "Local Agent": {
      "command": "node",
      "args": ["./agent.js"]
    }
  },
  "remote": {
    "Cloud Agent": {
      "url": "wss://agent.example.com/acp",
      "token": "sk-abc123..."
    },
    "Enterprise Agent": {
      "url": "wss://internal.corp.com/agent",
      "token": ""
    }
  }
}
```

## Protocol: WebSocket \+ ACP

Your server must implement a WebSocket endpoint that speaks the ACP (Agent Client Protocol) over JSON-RPC 2.0.

### Connection

The IDE connects using:

- **Transport:** WebSocket  
- **Authentication:** `Authorization` header with the configured token  
- **Request timeout:** 60 seconds per request

```
GET /acp HTTP/1.1
Upgrade: websocket
Authorization: <token from config>
```

## Session Creation: Git Info Exchange

When creating a session, the IDE sends git repository information in the `_meta` field of `session\new` request.

### Request: `_meta.remote` field

The IDE sends the current git state:

```json
{
  "jsonrpc": "2.0",
  "method": "session/new",
  "params": {
    "cwd": "",
    "mcpServers": [],
    "_meta": {
      "remote": {
        "url": "git@github.com:user/repo.git",
        "branch": "feature/my-branch",
        "revision": "abc123def456..."
      }
    }
  }
}
```

#### RemoteGitInfo Fields

| Field | Type | Description |
| :---- | :---- | :---- |
| `url` | string | Git remote URL (SSH or HTTPS) |
| `branch` | string | Name of the tracked remote branch (e.g., `main`, `feature/xyz`) |
| `revision` | string | Current commit hash (full SHA) |

### Response: `_meta.target` field

After your agent completes work, return the target branch info in session responses:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "sessionId": "...",
    "_meta": {
      "target": {
        "url": "git@github.com:user/repo.git",
        "branch": "refs/head/agent/changes-12345",
        "revision": "789xyz..."
      }
    }
  }
}
```

The IDE will:

1. Fetch the specified branch from `origin`  
2. Create a `VcsRef` for merge operations  
3. Present the user with options to merge/review the changes

## Complete Git Flow

### Step-by-step process

```
┌─────────────────┐                    ┌─────────────────┐
│   IntelliJ IDE  │                    │  Remote Server  │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         │  1. WebSocket Connect                │
         │  (Authorization: <token>)            │
         ├─────────────────────────────────────►│
         │                                      │
         │  2. session/create                   │
         │  _meta.remote: {                     │
         │    url: "git@.../repo.git",          │
         │    branch: "main",                   │
         │    revision: "abc123"                │
         │  }                                   │
         ├─────────────────────────────────────►│
         │                                      │
         │                      3. Clone/fetch repo
         │                      4. Checkout revision abc123
         │                      5. Do agent work (edit files)
         │                      6. Commit changes
         │                      7. Push to new branch
         │                                      │
         │  8. Session response                 │
         │  _meta.target: {                     │
         │    url: "git@.../repo.git",          │
         │    branch: "agent/task-xyz",         │
         │    revision: "def456"                │
         │  }                                   │
         │◄─────────────────────────────────────┤
         │                                      │
         │  9. Fetch origin/agent/task-xyz      │
         │  10. Present merge UI to user        │
         │                                      │
```

### Server-side git operations

Your server should:

1. **Clone or fetch** the repository using the provided `url`  
2. **Checkout** the exact `revision` from `_meta.remote`  
3. **Create a working branch** for your changes  
4. **Execute** the agent's task (file edits, etc.)  
5. **Commit** all changes  
6. **Push** to a new branch (e.g., `agent/<unique-id>`)  
7. **Return** the new branch info in `_meta.target`

## Testing Your Implementation

### 1\. Set up acp.json

Create `~/.jetbrains/acp.json`:

```json
{
  "remote": {
    "Test Remote Agent": {
      "url": "ws://localhost:8080/acp",
      "token": "test-token"
    }
  }
}
```

### 2\. Start your server

Ensure your WebSocket server is running and accessible at the configured URL.

### 3\. Open IntelliJ IDEA

1. Open a project that is a git repository  
2. Open the AI Assistant panel  
3. Select "Test Remote Agent" from the agent dropdown  
4. Send a request

