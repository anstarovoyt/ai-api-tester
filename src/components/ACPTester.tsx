import React, { useEffect, useMemo, useState } from 'react';
import PrettySelect from './PrettySelect';

interface ACPTesterProps {
  apiUrl: string;
  apiKey: string;
}

interface LogEntry {
  id: number;
  timestamp: string;
  direction: 'outgoing' | 'incoming' | 'notification' | 'raw' | 'error';
  payload: any;
}

interface AgentOption {
  name: string;
}

interface MethodConfig {
  template: string;
  description: string;
}

const methodConfigs: Record<string, MethodConfig> = {
  'session/init': {
    template: `{
  "client_id": "web-client",
  "metadata": {
    "channel": "web"
  }
}`,
    description: 'Creates a new ACP session with the selected agent. Use this to establish the initial handshake and attach any client context you want the agent to see for the lifetime of the session. The response typically includes the session identifier used by follow-up calls.<br><br><span class="font-semibold">client_id</span>: string - Unique identifier for the client<br><span class="font-semibold">metadata</span>: object - Optional metadata for tracing or routing<br>&nbsp;&nbsp;<span class="font-semibold">channel</span>: string - Client channel (e.g. web, cli)<br><span class="font-semibold">capabilities</span>: object - Optional client capability hints'
  },
  'session/send': {
    template: `{
  "session_id": "session-id",
  "message": {
    "role": "user",
    "content": "Hello from the client"
  }
}`,
    description: 'Sends a message to the agent within an existing session. Use this for back-and-forth conversation, tool triggers, or system-level instructions. Streaming responses may be supported by the agent depending on implementation.<br><br><span class="font-semibold">session_id</span>: string - Active session identifier<br><span class="font-semibold">message</span>: object - Message payload<br>&nbsp;&nbsp;<span class="font-semibold">role</span>: string - user | system | assistant<br>&nbsp;&nbsp;<span class="font-semibold">content</span>: string - Message content<br>&nbsp;&nbsp;<span class="font-semibold">metadata</span>: object - Optional message metadata<br><span class="font-semibold">stream</span>: boolean - Whether to stream responses'
  },
  'session/end': {
    template: `{
  "session_id": "session-id"
}`,
    description: 'Ends an ACP session and releases any server-side state associated with it. Call this when a conversation is complete or the client is shutting down. Some agents may return a final summary or cleanup status.<br><br><span class="font-semibold">session_id</span>: string - Session identifier to close<br><span class="font-semibold">reason</span>: string - Optional reason for termination'
  },
  'tools/list': {
    template: '{}',
    description: 'Lists tools available for the current agent along with optional metadata. Use this to discover what actions the agent can perform before sending calls. Some agents can include parameter schemas to prefill request payloads.<br><br><span class="font-semibold">include_schemas</span>: boolean - Include input schema details if supported'
  },
  'tools/call': {
    template: `{
  "tool": "lookup_customer",
  "arguments": {
    "customer_id": "cust_123"
  }
}`,
    description: 'Calls a tool exposed by the agent. This is the primary way to trigger external actions or structured capabilities. The response payload shape depends on the tool definition.<br><br><span class="font-semibold">tool</span>: string - Tool identifier<br><span class="font-semibold">arguments</span>: object - Tool arguments payload<br><span class="font-semibold">trace_id</span>: string - Optional tracing identifier'
  },
  'ping': {
    template: '{}',
    description: 'Checks ACP agent connectivity and measures basic responsiveness. Use this to verify the agent process is running before starting a session. No parameters are required.<br><br>No parameters required.'
  }
};

const acpMethods = [
  { value: 'session/init', label: 'Initialize Session' },
  { value: 'session/send', label: 'Send Message' },
  { value: 'session/end', label: 'End Session' },
  { value: 'tools/list', label: 'List Tools' },
  { value: 'tools/call', label: 'Call Tool' },
  { value: 'ping', label: 'Ping' }
];

const apiUrlOptions = [
  'http://localhost:3001/acp',
  'http://localhost:3001'
];

const ACPTester: React.FC<ACPTesterProps> = ({ apiUrl, apiKey }) => {
  const [params, setParams] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiUrlValue, setApiUrlValue] = useState(apiUrl);
  const [apiKeyValue, setApiKeyValue] = useState(apiKey);
  const [selectedMethod, setSelectedMethod] = useState(acpMethods[0].value);
  const [showMethodInput, setShowMethodInput] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [requestId, setRequestId] = useState(1);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState(true);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [agentReady, setAgentReady] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [sessionRole, setSessionRole] = useState('user');
  const [sessionContent, setSessionContent] = useState('');
  const [sessionInitParams, setSessionInitParams] = useState(`{\n  \"client_id\": \"web-client\",\n  \"metadata\": {\n    \"channel\": \"web\"\n  }\n}`);
  const [sessionReady, setSessionReady] = useState(false);

  const apiUrlChoices = useMemo(() => (
    apiUrlOptions.includes(apiUrlValue)
      ? apiUrlOptions
      : [...apiUrlOptions, apiUrlValue]
  ), [apiUrlValue]);

  const resolveEndpoint = (baseUrl: string, suffix: '/acp' | '/acp/logs' | '/acp/agents' | '/acp/select') => {
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (suffix === '/acp') {
      return trimmed.endsWith('/acp') ? trimmed : `${trimmed}/acp`;
    }
    if (trimmed.endsWith(suffix)) {
      return trimmed;
    }
    if (trimmed.endsWith('/acp')) {
      return `${trimmed}${suffix.replace('/acp', '')}`;
    }
    return `${trimmed}${suffix}`;
  };

  const addLocalLog = (entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    setLogEntries((prev) => [
      ...prev,
      {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        ...entry
      }
    ]);
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch(resolveEndpoint(apiUrlValue, '/acp/logs'));
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      if (Array.isArray(data.items)) {
        setLogEntries((prev) => {
          const merged = new Map(prev.map((entry) => [entry.id, entry]));
          data.items.forEach((entry) => merged.set(entry.id, entry));
          return Array.from(merged.values()).sort((a, b) => a.id - b.id);
        });
      }
    } catch {
      // Ignore log fetch errors to avoid noisy UI.
    }
  };

  const fetchAgents = async () => {
    try {
      const res = await fetch(resolveEndpoint(apiUrlValue, '/acp/agents'));
      if (!res.ok) {
        addLocalLog({ direction: 'error', payload: 'Failed to load ACP agents.' });
        return;
      }
      const data = await res.json();
      if (Array.isArray(data.agents)) {
        setAgents(data.agents);
        if (!selectedAgent && data.agents.length > 0) {
          setSelectedAgent(data.agents[0].name);
        }
      }
    } catch {
      addLocalLog({ direction: 'error', payload: 'Failed to connect to ACP server.' });
    }
  };

  useEffect(() => {
    const config = methodConfigs[selectedMethod];
    if (config) {
      if (config.template) {
        try {
          const parsed = JSON.parse(config.template);
          setParams(JSON.stringify(parsed, null, 2));
        } catch {
          setParams(config.template);
        }
      } else {
        setParams('');
      }
    }
  }, [selectedMethod]);

  useEffect(() => {
    fetchAgents();
  }, [apiUrlValue]);

  useEffect(() => {
    if (!autoRefreshLogs) {
      return;
    }
    fetchLogs();
    const interval = window.setInterval(fetchLogs, 2000);
    return () => window.clearInterval(interval);
  }, [autoRefreshLogs, apiUrlValue]);

  const buildHeaders = () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKeyValue.trim()) {
      headers.Authorization = `Bearer ${apiKeyValue.trim()}`;
    }
    return headers;
  };

  const selectAgent = async () => {
    if (!selectedAgent) {
      addLocalLog({ direction: 'error', payload: 'Select an ACP agent before starting.' });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(resolveEndpoint(apiUrlValue, '/acp/select'), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ agent: selectedAgent })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addLocalLog({ direction: 'error', payload: data.error?.message || 'Failed to start ACP agent.' });
        return;
      }
      setAgentReady(true);
      addLocalLog({ direction: 'incoming', payload: `ACP agent "${selectedAgent}" started.` });
      fetchLogs();
    } catch {
      addLocalLog({ direction: 'error', payload: 'Failed to reach ACP server.' });
    } finally {
      setLoading(false);
    }
  };

  const sendAcpRequest = async (method: string, paramsPayload: object) => {
    setLoading(true);
    const payload = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: paramsPayload
    };
    setRequestId((prev) => prev + 1);

    try {
      const res = await fetch(resolveEndpoint(apiUrlValue, '/acp'), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMessage = errorData.error?.message ||
          errorData.message ||
          `HTTP Error: ${res.status} - ${res.statusText}`;
        addLocalLog({ direction: 'error', payload: `API Error: ${errorMessage}` });
        return;
      }

      const data = await res.json().catch(() => null);
      if (!data) {
        const text = await res.text();
        if (text) {
          addLocalLog({ direction: 'incoming', payload: text });
        }
        return null;
      }
      if (method === 'session/init') {
        const sessionFromResult = data.result?.session_id || data.result?.sessionId || data.session_id || data.sessionId;
        if (sessionFromResult) {
          setSessionId(sessionFromResult);
          setSessionReady(true);
        }
      }
      fetchLogs();
      return data;
    } catch (err) {
      addLocalLog({
        direction: 'error',
        payload: err instanceof Error ? err.message : 'Unknown ACP error'
      });
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let requestBody = {};
    if (params) {
      try {
        requestBody = JSON.parse(params);
      } catch (parseError) {
        addLocalLog({
          direction: 'error',
          payload: `Invalid JSON in parameters: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`
        });
        return;
      }
    }

    await sendAcpRequest(selectedMethod, requestBody);
  };

  const currentDescription = methodConfigs[selectedMethod]?.description;

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-800 mb-6">ACP (Agent Client Protocol) Tester</h1>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">ACP Server URL</label>
            <div className="flex items-center space-x-2">
              <PrettySelect
                value={apiUrlValue}
                onChange={setApiUrlValue}
                options={apiUrlChoices.map((url) => ({ value: url, label: url }))}
                className="w-full"
              />
              <button
                type="button"
                onClick={() => setShowUrlInput(!showUrlInput)}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                {showUrlInput ? 'Hide' : 'Edit'}
              </button>
            </div>
            {showUrlInput && (
              <input
                type="text"
                value={apiUrlValue}
                onChange={(e) => setApiUrlValue(e.target.value)}
                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter custom ACP server URL"
              />
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Client Token (Optional)</label>
            <input
              type="password"
              value={apiKeyValue}
              onChange={(e) => setApiKeyValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Agent Selection</h2>
            <p className="text-sm text-gray-500 mt-1">
              Pick an ACP agent from your JetBrains config and start a session.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
              agentReady ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
            }`}>
              <span className={`w-2 h-2 rounded-full mr-2 ${agentReady ? 'bg-green-500' : 'bg-gray-400'}`}></span>
              {agentReady ? 'Agent Ready' : 'Not Connected'}
            </span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
          <PrettySelect
            value={selectedAgent}
            onChange={(value) => {
              setSelectedAgent(value);
              setAgentReady(false);
            }}
            options={agents.map((agent) => ({ value: agent.name, label: agent.name }))}
            placeholder="Select ACP agent"
            className="w-full"
          />
          <button
            type="button"
            onClick={selectAgent}
            disabled={loading || !selectedAgent}
            className={`px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              loading || !selectedAgent ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            Start Agent
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Create Session</h2>
        <p className="text-sm text-gray-500 mt-1">
          Provide session init parameters. The returned session ID will be filled automatically.
        </p>
        <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Init Parameters (JSON)</label>
        <textarea
          value={sessionInitParams}
          onChange={(e) => setSessionInitParams(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-32 text-xs"
          placeholder='{"client_id":"web-client"}'
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              try {
                const parsed = sessionInitParams ? JSON.parse(sessionInitParams) : {};
                sendAcpRequest('session/init', parsed);
              } catch (err) {
                addLocalLog({
                  direction: 'error',
                  payload: `Invalid JSON in session init: ${err instanceof Error ? err.message : 'Unknown error'}`
                });
              }
            }}
            disabled={loading || !selectedAgent}
            className={`inline-flex items-center px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
              loading || !selectedAgent ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            Initialize Session
          </button>
          <button
            type="button"
            onClick={() => {
              if (!sessionId) {
                addLocalLog({ direction: 'error', payload: 'Set a session_id before ending the session.' });
                return;
              }
              sendAcpRequest('session/end', { session_id: sessionId });
            }}
            disabled={loading || !sessionId}
            className={`inline-flex items-center px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 ${
              loading || !sessionId ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            End Session
          </button>
        </div>
        {sessionId && (
          <p className="mt-3 text-xs text-gray-500">Active session: {sessionId}</p>
        )}
      </div>

      <div className={`bg-white rounded-lg shadow-md p-6 mb-6 ${sessionReady ? '' : 'opacity-60'}`}>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Session Communication</h2>
            <p className="text-sm text-gray-500 mt-1">
              Send messages in the active session. Unlocks after session initialization.
            </p>
          </div>
          <div className="text-xs text-gray-500">
            {sessionReady ? 'Session ready' : 'Awaiting session init'}
          </div>
        </div>
        <div className="mt-4 border border-gray-200 rounded-lg p-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">Session ID</label>
          <input
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="session-id"
            disabled={!sessionReady}
          />
          <label className="block text-xs font-medium text-gray-600 mt-3 mb-1">Role</label>
          <PrettySelect
            value={sessionRole}
            onChange={setSessionRole}
            options={[
              { value: 'user', label: 'user' },
              { value: 'system', label: 'system' },
              { value: 'assistant', label: 'assistant' }
            ]}
            className="w-full"
          />
          <label className="block text-xs font-medium text-gray-600 mt-3 mb-1">Message</label>
          <textarea
            value={sessionContent}
            onChange={(e) => setSessionContent(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-24 text-xs"
            placeholder="Send a message to the agent..."
            disabled={!sessionReady}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (!sessionId) {
                  addLocalLog({ direction: 'error', payload: 'Set a session_id before sending a message.' });
                  return;
                }
                sendAcpRequest('session/send', {
                  session_id: sessionId,
                  message: {
                    role: sessionRole,
                    content: sessionContent
                  }
                });
              }}
              disabled={loading || !sessionId || !sessionReady}
              className={`inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                loading || !sessionId || !sessionReady ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Send Message
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Endpoints</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">ACP Method</label>
            <div className="flex items-center space-x-2">
              <PrettySelect
                value={selectedMethod}
                onChange={setSelectedMethod}
                options={acpMethods.map((method) => ({ value: method.value, label: method.label }))}
                className="w-full"
              />
              <button
                type="button"
                onClick={() => setShowMethodInput(!showMethodInput)}
                className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                {showMethodInput ? 'Hide' : 'Edit'}
              </button>
            </div>
            {showMethodInput && (
              <input
                type="text"
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter custom method name"
              />
            )}
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Method Description</label>
            <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-md text-xs">
              {currentDescription ? (
                <div dangerouslySetInnerHTML={{ __html: currentDescription }} />
              ) : (
                'No description available for this method.'
              )}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Request Parameters (JSON)</label>
            <textarea
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder='{"session_id": "session-id"}'
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-48 text-xs"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {loading ? 'Sending...' : 'Send Request'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Live Log</h2>
            <p className="text-sm text-gray-500 mt-1">
              Mirrors the ACP CLI output, including requests, responses, and notifications.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center text-sm text-gray-600 gap-2">
              <input
                type="checkbox"
                checked={autoRefreshLogs}
                onChange={(e) => setAutoRefreshLogs(e.target.checked)}
              />
              Auto refresh
            </label>
            <button
              type="button"
              onClick={fetchLogs}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="mt-4 border border-gray-200 rounded-md max-h-96 overflow-auto">
          {logEntries.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No log entries yet.</div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {logEntries.slice().reverse().map((entry) => (
                <li key={entry.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className="font-mono">{entry.timestamp}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                      entry.direction === 'outgoing' ? 'bg-blue-100 text-blue-700' :
                      entry.direction === 'incoming' ? 'bg-green-100 text-green-700' :
                      entry.direction === 'notification' ? 'bg-purple-100 text-purple-700' :
                      entry.direction === 'error' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {entry.direction}
                    </span>
                    {entry.payload?.method && (
                      <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">
                        {entry.payload.method}
                      </span>
                    )}
                  </div>
                  <pre className="mt-2 bg-gray-50 border border-gray-200 rounded p-2 text-xs overflow-auto">
                    {typeof entry.payload === 'string'
                      ? entry.payload
                      : JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ACPTester;
