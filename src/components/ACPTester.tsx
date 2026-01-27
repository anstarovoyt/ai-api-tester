import React, { useEffect, useState } from 'react';

interface ACPTesterProps {
  apiUrl: string;
  apiKey: string;
}

type HttpMethod = 'GET' | 'POST' | 'DELETE';

interface MethodConfig {
  method: HttpMethod;
  template: string;
  description: string;
}

const methodConfigs: Record<string, MethodConfig> = {
  '/acp/health': {
    method: 'GET',
    template: '',
    description: 'Basic health check for the ACP server. Returns status and version info when available.'
  },
  '/acp/agents': {
    method: 'GET',
    template: '',
    description: 'Lists registered agents that can be targeted by ACP sessions.'
  },
  '/acp/agents/register': {
    method: 'POST',
    template: '{"agent_id": "agent-1", "display_name": "Support Agent", "capabilities": ["chat", "tools"]}',
    description: 'Registers a new agent with the ACP server.<br><br><span class="font-semibold">agent_id</span>: string - Unique agent identifier<br><span class="font-semibold">display_name</span>: string - Human-friendly name<br><span class="font-semibold">capabilities</span>: string[] - Supported capabilities'
  },
  '/acp/sessions': {
    method: 'POST',
    template: '{"agent_id": "agent-1", "client_id": "client-1", "metadata": {"channel": "web"}}',
    description: 'Creates a new ACP session between a client and an agent.<br><br><span class="font-semibold">agent_id</span>: string - Target agent identifier<br><span class="font-semibold">client_id</span>: string - Client identifier<br><span class="font-semibold">metadata</span>: object - Optional session metadata'
  },
  '/acp/sessions/list': {
    method: 'GET',
    template: '',
    description: 'Lists active sessions for the configured ACP server.'
  },
  '/acp/sessions/session-id': {
    method: 'GET',
    template: '',
    description: 'Retrieves a single session. Replace <span class="font-semibold">session-id</span> with a real session identifier.'
  },
  '/acp/sessions/session-id/delete': {
    method: 'DELETE',
    template: '',
    description: 'Ends a session. Replace <span class="font-semibold">session-id</span> with a real session identifier.'
  },
  '/acp/sessions/session-id/messages': {
    method: 'POST',
    template: '{"role": "user", "content": "Hello from the client", "stream": false}',
    description: 'Sends a message to the agent in the specified session.<br><br><span class="font-semibold">role</span>: string - sender role (user, system, assistant)<br><span class="font-semibold">content</span>: string - message content<br><span class="font-semibold">stream</span>: boolean - request streaming responses'
  },
  '/acp/sessions/session-id/events': {
    method: 'GET',
    template: '',
    description: 'Streams session events (often via SSE). Replace <span class="font-semibold">session-id</span> with a real session identifier.'
  },
  '/acp/tools': {
    method: 'GET',
    template: '',
    description: 'Lists tools that can be invoked by the client or agent.'
  },
  '/acp/tools/call': {
    method: 'POST',
    template: '{"tool": "lookup_customer", "arguments": {"customer_id": "cust_123"}}',
    description: 'Invokes a tool with arguments.<br><br><span class="font-semibold">tool</span>: string - Tool name<br><span class="font-semibold">arguments</span>: object - Tool arguments'
  }
};

const acpMethods = [
  { value: '/acp/health', label: 'Health Check' },
  { value: '/acp/agents', label: 'List Agents' },
  { value: '/acp/agents/register', label: 'Register Agent' },
  { value: '/acp/sessions', label: 'Create Session' },
  { value: '/acp/sessions/list', label: 'List Sessions' },
  { value: '/acp/sessions/session-id', label: 'Get Session' },
  { value: '/acp/sessions/session-id/delete', label: 'End Session' },
  { value: '/acp/sessions/session-id/messages', label: 'Send Message' },
  { value: '/acp/sessions/session-id/events', label: 'Stream Events' },
  { value: '/acp/tools', label: 'List Tools' },
  { value: '/acp/tools/call', label: 'Call Tool' }
];

const apiUrlOptions = [
  'http://localhost:3001',
  'http://localhost:1234'
];

const ACPTester: React.FC<ACPTesterProps> = ({ apiUrl, apiKey }) => {
  const [params, setParams] = useState('');
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiUrlValue, setApiUrlValue] = useState(apiUrl);
  const [apiKeyValue, setApiKeyValue] = useState(apiKey);
  const [selectedMethod, setSelectedMethod] = useState(acpMethods[0].value);
  const [showMethodInput, setShowMethodInput] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [httpMethod, setHttpMethod] = useState<HttpMethod>(methodConfigs[acpMethods[0].value].method);

  useEffect(() => {
    const config = methodConfigs[selectedMethod];
    if (config) {
      setHttpMethod(config.method);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const targetPath = selectedMethod.startsWith('/') ? selectedMethod : `/${selectedMethod}`;
      const proxyUrl = apiUrlValue.includes('localhost:1234')
        ? `http://localhost:3001${targetPath}`
        : `${apiUrlValue}${targetPath}`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (apiKeyValue.trim()) {
        headers.Authorization = `Bearer ${apiKeyValue.trim()}`;
      }

      let res: Response;
      if (httpMethod === 'GET' || httpMethod === 'DELETE') {
        res = await fetch(proxyUrl, {
          method: httpMethod,
          headers
        });
      } else {
        let requestBody = {};
        if (params) {
          try {
            requestBody = JSON.parse(params);
          } catch (parseError) {
            const errorMsg = `Invalid JSON in parameters: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`;
            setError(errorMsg);
            return;
          }
        }

        res = await fetch(proxyUrl, {
          method: httpMethod,
          headers,
          body: JSON.stringify(requestBody)
        });
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMessage = errorData.error?.message ||
          errorData.message ||
          `HTTP Error: ${res.status} - ${res.statusText}`;
        setError(`API Error: ${errorMessage}`);
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        setResponse(JSON.stringify(data, null, 2));
      } else {
        const text = await res.text();
        setResponse(text || 'Empty response');
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
          if (err.message.includes('CORS') || err.message.includes('Access to fetch')) {
            setError(`CORS Error: ${err.message}\n\nIf this is a local ACP server:\n- Enable CORS on the server\n- Or route requests through the local proxy on port 3001`);
          } else {
            setError(`Network Error: ${err.message}\n\nMake sure the ACP server is running and reachable.`);
          }
        } else {
          setError(`Request Error: ${err.message}`);
        }
      } else {
        setError('An unknown error occurred');
      }
    } finally {
      setLoading(false);
    }
  };

  const currentDescription = methodConfigs[selectedMethod]?.description;

  const apiUrlChoices = apiUrlOptions.includes(apiUrlValue)
    ? apiUrlOptions
    : [...apiUrlOptions, apiUrlValue];

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-800 mb-6">ACP (Agent Client Protocol) Tester</h1>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">ACP Server URL</label>
            <div className="flex items-center space-x-2">
              <select
                value={apiUrlValue}
                onChange={(e) => setApiUrlValue(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {apiUrlChoices.map((url) => (
                  <option key={url} value={url}>
                    {url}
                  </option>
                ))}
              </select>
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
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Test Endpoint</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">ACP Method</label>
            <div className="flex items-center space-x-2">
              <select
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {acpMethods.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
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
                placeholder="Enter custom method path"
              />
            )}
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">HTTP Method</label>
            <select
              value={httpMethod}
              onChange={(e) => setHttpMethod(e.target.value as HttpMethod)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="DELETE">DELETE</option>
            </select>
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
              placeholder='{"role": "user", "content": "Hello from the client"}'
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-48 text-xs"
            />
            {(httpMethod === 'GET' || httpMethod === 'DELETE') && (
              <p className="text-xs text-gray-500 mt-2">
                Parameters are ignored for GET/DELETE requests.
              </p>
            )}
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

      {response && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold text-gray-700 mb-4">Response</h2>
          <pre className="bg-gray-100 p-4 rounded-md overflow-auto max-h-96 text-xs">
            {response}
          </pre>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
          <p className="font-semibold">Error Details:</p>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
};

export default ACPTester;
