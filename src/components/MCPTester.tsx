import React, { useEffect, useState } from 'react';

interface MCPTesterProps {
  apiUrl: string;
  apiKey: string;
}

interface MethodConfig {
  template: string;
  description: string;
}

const methodConfigs: Record<string, MethodConfig> = {
  'initialize': {
    template: `{
  "protocolVersion": "2024-11-05",
  "capabilities": {
    "tools": {},
    "resources": {},
    "prompts": {}
  },
  "clientInfo": {
    "name": "api-tester",
    "version": "1.0.0"
  }
}`,
    description: 'Establishes connection with the MCP server and negotiates capabilities. This must be called first before any other operations.'
  },
  'tools/list': {
    template: '{}',
    description: 'Discovers all available tools on the MCP server. Tools are functions that can be called to perform actions.'
  },
  'tools/call': {
    template: `{
  "name": "tool_name",
  "arguments": {}
}`,
    description: 'Executes a specific tool with the provided arguments.<br><br><span class="font-semibold">name</span>: string - Tool name<br><span class="font-semibold">arguments</span>: object - Tool arguments'
  },
  'resources/list': {
    template: '{}',
    description: 'Lists all available resources on the server. Resources are data sources that can be read.'
  },
  'resources/read': {
    template: `{
  "uri": "file:///path/to/resource"
}`,
    description: 'Retrieves the content of a specific resource by its URI.<br><br><span class="font-semibold">uri</span>: string - Resource identifier'
  },
  'prompts/list': {
    template: '{}',
    description: 'Lists all available prompt templates on the server.'
  },
  'prompts/get': {
    template: `{
  "name": "prompt_name",
  "arguments": {}
}`,
    description: 'Retrieves a specific prompt template with the provided arguments.<br><br><span class="font-semibold">name</span>: string - Prompt name<br><span class="font-semibold">arguments</span>: object - Prompt arguments'
  },
  'ping': {
    template: '{}',
    description: 'Simple ping to check if the server is responsive.'
  }
};

const mcpMethods = [
  { value: 'initialize', label: 'Initialize Connection', category: 'Lifecycle' },
  { value: 'tools/list', label: 'List Tools', category: 'Tools' },
  { value: 'tools/call', label: 'Call Tool', category: 'Tools' },
  { value: 'resources/list', label: 'List Resources', category: 'Resources' },
  { value: 'resources/read', label: 'Read Resource', category: 'Resources' },
  { value: 'prompts/list', label: 'List Prompts', category: 'Prompts' },
  { value: 'prompts/get', label: 'Get Prompt', category: 'Prompts' },
  { value: 'ping', label: 'Ping', category: 'Utility' }
];

const apiUrlOptions = [
  'http://localhost:3001',
  'http://localhost:4000'
];

const MCPTester: React.FC<MCPTesterProps> = ({ apiUrl, apiKey }) => {
  const [params, setParams] = useState('');
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiUrlValue, setApiUrlValue] = useState(apiUrl);
  const [apiKeyValue, setApiKeyValue] = useState(apiKey);
  const [selectedMethod, setSelectedMethod] = useState('initialize');
  const [showMethodInput, setShowMethodInput] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [requestId, setRequestId] = useState(1);

  useEffect(() => {
    const config = methodConfigs[selectedMethod];
    if (config) {
      try {
        const parsed = JSON.parse(config.template);
        setParams(JSON.stringify(parsed, null, 2));
      } catch {
        setParams(config.template);
      }
    } else {
      setParams('{}');
    }
  }, [selectedMethod]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      let parsedParams = {};
      if (params.trim()) {
        try {
          parsedParams = JSON.parse(params);
        } catch (parseError) {
          const errorMsg = `Invalid JSON in parameters: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`;
          setError(errorMsg);
          return;
        }
      }

      const requestBody = {
        jsonrpc: '2.0',
        id: requestId,
        method: selectedMethod,
        params: parsedParams
      };
      setRequestId((prev) => prev + 1);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (apiKeyValue.trim()) {
        headers.Authorization = `Bearer ${apiKeyValue.trim()}`;
      }

      const res = await fetch(apiUrlValue, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMessage = errorData.error?.message ||
          errorData.message ||
          `HTTP Error: ${res.status} - ${res.statusText}`;
        setError(`API Error: ${errorMessage}`);
        return;
      }

      const data = await res.json().catch(() => null);
      if (data) {
        setResponse(JSON.stringify(data, null, 2));
      } else {
        const text = await res.text();
        setResponse(text || 'Empty response');
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
          if (err.message.includes('CORS') || err.message.includes('Access to fetch')) {
            setError(`CORS Error: ${err.message}\n\nIf this is a local MCP server:\n- Enable CORS on the server\n- Or route requests through the local proxy on port 3001`);
          } else {
            setError(`Network Error: ${err.message}\n\nMake sure the MCP server is running and reachable.`);
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
      <h1 className="text-3xl font-bold text-gray-800 mb-6">MCP (Model Context Protocol) Tester</h1>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">MCP Server URL</label>
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
                placeholder="Enter custom MCP server URL"
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
            <label className="block text-xs font-medium text-gray-600 mb-1">MCP Method</label>
            <div className="flex items-center space-x-2">
              <select
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {Object.entries(
                  mcpMethods.reduce((acc, method) => {
                    if (!acc[method.category]) acc[method.category] = [];
                    acc[method.category].push(method);
                    return acc;
                  }, {} as Record<string, typeof mcpMethods>)
                ).map(([category, methods]) => (
                  <optgroup key={category} label={category}>
                    {methods.map((method) => (
                      <option key={method.value} value={method.value}>
                        {method.label}
                      </option>
                    ))}
                  </optgroup>
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
              placeholder="{}"
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

export default MCPTester;
