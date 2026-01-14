# OpenAI Compatible API Tester - Full Stack

This is a full-stack API testing tool that includes:
1. Frontend React application for testing OpenAI-compatible APIs
2. Backend proxy server to handle CORS issues

## Features

### Frontend (React)
- Editable API URL with dropdown and manual edit
- OpenAI methods dropdown with manual edit capability  
- Detailed error handling including CORS issues
- Support for both GET and POST requests
- Model listing functionality

### Backend (Node.js/Express)
- Proxy server to handle CORS restrictions
- API request forwarding with proper headers
- Health check endpoint

## Setup Instructions

### Prerequisites
- Node.js (v14+)
- npm or yarn

### Installation
```bash
npm install
```

### Running the Application

1. **Start the backend proxy server:**
```bash
npm run server
```

2. **Start the frontend development server:**
```bash
npm run client
```

3. **Or run both simultaneously:**
```bash
npm run dev
```

### Usage

1. The frontend will be available at `http://localhost:3000`
2. The backend proxy server runs on `http://localhost:3001`
3. When testing local APIs (like `http://localhost:1234`), the proxy server handles CORS issues

## API Endpoints

### Frontend
- `http://localhost:3000` - Main application interface

### Backend
- `http://localhost:3001/` - Proxy for API requests

## Configuration

The proxy server is configured to forward requests to:
- Target: `http://localhost:1234`
- Authorization headers are automatically forwarded