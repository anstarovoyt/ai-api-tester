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

**Frontend:** React 19, TypeScript, Vite, Tailwind CSS

**Backend:** Node.js, Express, http-proxy-middleware

## Setup Instructions

### Prerequisites
- Node.js (v14+)
- npm or yarn

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
| `http://localhost:3001/` | Proxy server for API requests |
| `ws://localhost:3010/acp` | ACP Remote Run WebSocket server |
| `http://localhost:3010/acp/agents` | Lists local ACP agents from `~/.jetbrains/acp.json` |

## ACP Remote Run Server

Run the dedicated remote-run WebSocket server (no HTTP JSON-RPC proxy):

```bash
npm run server:remote-run
```

Environment variables:

- `ACP_REMOTE_PORT` (default: `3010`)
- `ACP_REMOTE_PATH` (default: `/acp`)
- `ACP_REMOTE_TOKEN` (optional)
- `ACP_REMOTE_GIT_ROOT` (default: `~/git`)
