# API Tester

A full-stack API testing tool for OpenAI-compatible APIs, MCP, A2A, and ACP protocols with a built-in CORS proxy server.

## Features

### Supported Protocols
- **OpenAI API** - Full support for OpenAI-compatible endpoints including chat completions, embeddings, images, audio, and more
- **MCP (Model Context Protocol)** - Testing interface for MCP APIs
- **A2A (Agent-to-Agent)** - Testing interface for A2A communication protocols
- **ACP (Agent Client Protocol)** - Testing interface for ACP APIs

### Frontend (React + TypeScript)
- Tabbed interface for different API protocols
- Editable API URL with pre-configured options (localhost, OpenAI, Anthropic, Cohere, Groq)
- 17+ pre-built OpenAI method templates with descriptions
- Custom method editing capability
- Detailed error handling including CORS diagnostics
- Support for both GET and POST requests
- Request/response logging to browser console

### Backend (Node.js/Express)
- Proxy server to bypass CORS restrictions
- API request forwarding with proper headers
- WebSocket proxying support
- 60-second timeout for long-running requests
- Health check endpoint

## Tech Stack

**Frontend:** React 19, TypeScript, Vite 7, Tailwind CSS 4

**Backend:** Node.js, Express, http-proxy-middleware, WebSocket (ws)

## Monorepo Structure

| Package | Description |
|---------|-------------|
| `packages/frontend` | React + Vite frontend application |
| `packages/server-main` | Gateway server (Express) with OpenAI proxy, MCP, and ACP JSON-RPC |
| `packages/server-remote-acp` | ACP WebSocket servers (including remote-run) |
| `packages/acp-runtime` | ACP stdio runtime |
| `packages/integration-tests` | Integration tests for the project |

## Setup Instructions

### Prerequisites
- Node.js (v18+)
- npm

### Installation
```bash
npm install
```

### Running the Application

Start both frontend and backend simultaneously:
```bash
npm start
```

Or run them separately:
```bash
# Backend proxy server (port 3001)
npm run server

# Frontend dev server (port 3000)
npm run client
```

### Build for Production
```bash
npm run build
```

### Running Tests
```bash
# Run all tests
npm test

# Run tests for specific packages
npm run test:acp-runtime
npm run test:server-main
npm run test:server-remote-acp
npm run test:integration
```

### Type Checking
```bash
npm run typecheck
```

## Usage

1. Open `http://localhost:3000` in your browser
2. Select the protocol tab (OpenAI API, MCP, A2A, or ACP)
3. Enter your API URL and API key
4. Select a method from the dropdown or enter a custom one
5. Modify the request body as needed
6. Click "Send Request" to test

## Configuration

The proxy server forwards requests to `http://localhost:1234` by default, making it ideal for testing local LLM servers like LM Studio.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `http://localhost:3000` | Frontend application |
| `http://localhost:3001/` | Gateway server (OpenAI proxy + MCP + ACP JSON-RPC) |
| `ws://localhost:3001/acp` | ACP WebSocket proxy (gateway) |
| `ws://localhost:3011/acp` | ACP Remote Run WebSocket server |
| `http://localhost:3011/acp/agents` | Lists local ACP agents from `~/.jetbrains/acp.json` |

## ACP Remote Run Server

Run the dedicated remote-run WebSocket server (no HTTP JSON-RPC proxy):

```bash
npm run server:remote-run
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ACP_REMOTE_PORT` | `3011` | Server port |
| `ACP_REMOTE_PATH` | `/acp` | WebSocket path |
| `ACP_REMOTE_TOKEN` | - | Optional authentication token |
| `ACP_REMOTE_GIT_ROOT` | `~/git` | Root directory for git repositories |
| `ACP_REMOTE_SESSION_IDLE_TTL_MS` | `1800000` | Session/worktree idle timeout (30 min) |

Notes:

- `~/.jetbrains/acp.json` is parsed as JSON5 (comments and trailing commas allowed)
- Agent `env` values in `agent_servers` are passed to the local ACP process; non-string values are stringified and `null`/`undefined` removes the variable

## Documentation

See the [specs](./specs/README.md) directory for detailed documentation:

- [Protocol Overview](./specs/protocol/overview.md)
- [Architecture](./specs/architecture/index.md)
- [Remote Run Implementation](./specs/implementation/remote-run.md)
