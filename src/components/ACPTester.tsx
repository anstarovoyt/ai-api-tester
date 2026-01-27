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
    description: 'Creates a new ACP session with the selected agent.'
  },
  'session/send': {
    template: `{
  "session_id": "session-id",
  "message": {
    "role": "user",
    "content": "Hello from the client"
  }
}`,
    description: 'Sends a message to the agent in a session.'
  },
  'session/end': {
    template: `{
  "session_id": "session-id"
}`,
    description: 'Ends an ACP session.'
  },
  'tools/list': {
    template: '{}',
    description: 'Lists tools available for the current agent.'
  },
  'tools/call': {
    template: `{
  "tool": "lookup_customer",
  "arguments": {
    "customer_id": "cust_123"
  }
}`,
    description: 'Calls a tool with arguments.'
  },
  'ping': {
    template: '{}',
    description: 'Checks the ACP agent connectivity.'
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    let requestBody = {};
    if (params) {
      try {
        requestBody = JSON.parse(params);
      } catch (parseError) {
        addLocalLog({
          direction: 'error',
          payload: `Invalid JSON in parameters: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`
        });
        setLoading(false);
        return;
      }
    }

    const payload = {
      jsonrpc: '2.0',
      id: requestId,
      method: selectedMethod,
      params: requestBody
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
      }
      fetchLogs();
    } catch (err) {
      addLocalLog({
        direction: 'error',
        payload: err instanceof Error ? err.message : 'Unknown ACP error'
      });
    } finally {
      setLoading(false);
    }
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
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Test Endpoint</h2>
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
              {currentDescription || 'No description available for this method.'}
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
