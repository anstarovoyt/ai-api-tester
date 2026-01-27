import React, { useEffect, useMemo, useState } from 'react';

interface MCPTesterProps {
  apiUrl: string;
  apiKey: string;
}

interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: object;
}

interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface Prompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface LogEntry {
  id: number;
  timestamp: string;
  direction: 'outgoing' | 'incoming' | 'notification' | 'raw' | 'error';
  payload: any;
}

const apiUrlOptions = [
  'http://localhost:3001/mcp',
  'http://localhost:3001',
  'http://localhost:4000/mcp'
];

const defaultInitParams = {
  protocolVersion: '2024-11-05',
  capabilities: {
    tools: {},
    resources: {},
    prompts: {}
  },
  clientInfo: {
    name: 'api-tester',
    version: '1.0.0'
  }
};

const methodDescriptions: Record<string, string> = {
  'initialize': 'Establishes connection with the MCP server and negotiates capabilities. This must be called first before any other operations.',
  'tools/list': 'Discovers all available tools on the MCP server.',
  'tools/call': 'Executes a specific tool with the provided arguments.',
  'resources/list': 'Lists all available resources on the server.',
  'resources/read': 'Retrieves the content of a specific resource by its URI.',
  'prompts/list': 'Lists all available prompt templates on the server.',
  'prompts/get': 'Retrieves a specific prompt template with the provided arguments.',
  'ping': 'Simple ping to check if the server is responsive.',
  'notifications/initialized': 'Notification that client initialization is complete.'
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

const MCPTester: React.FC<MCPTesterProps> = ({ apiUrl, apiKey }) => {
  const [loading, setLoading] = useState(false);
  const [apiUrlValue, setApiUrlValue] = useState(apiUrl);
  const [apiKeyValue, setApiKeyValue] = useState(apiKey);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [requestId, setRequestId] = useState(1);
  const [isInitialized, setIsInitialized] = useState(false);
  const [serverName, setServerName] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState(true);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [availableResources, setAvailableResources] = useState<Resource[]>([]);
  const [availablePrompts, setAvailablePrompts] = useState<Prompt[]>([]);
  const [toolName, setToolName] = useState('');
  const [toolArguments, setToolArguments] = useState('{}');
  const [resourceUri, setResourceUri] = useState('');
  const [promptName, setPromptName] = useState('');
  const [promptArguments, setPromptArguments] = useState('{}');
  const [advancedMethod, setAdvancedMethod] = useState('initialize');
  const [advancedParams, setAdvancedParams] = useState(JSON.stringify(defaultInitParams, null, 2));
  const [showMethodInput, setShowMethodInput] = useState(false);
  const [stage3Tab, setStage3Tab] = useState<'tools' | 'resources' | 'prompts'>('tools');

  const apiUrlChoices = useMemo(() => (
    apiUrlOptions.includes(apiUrlValue)
      ? apiUrlOptions
      : [...apiUrlOptions, apiUrlValue]
  ), [apiUrlValue]);

  const resolveEndpoint = (baseUrl: string, suffix: '/mcp' | '/mcp/logs') => {
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (suffix === '/mcp') {
      return trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
    }
    if (trimmed.endsWith('/mcp/logs')) {
      return trimmed;
    }
    if (trimmed.endsWith('/mcp')) {
      return `${trimmed}/logs`;
    }
    return `${trimmed}/mcp/logs`;
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch(resolveEndpoint(apiUrlValue, '/mcp/logs'));
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      if (Array.isArray(data.items)) {
        setLogEntries(data.items);
      }
    } catch {
      // Ignore log fetch errors to avoid noisy UI.
    }
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

  useEffect(() => {
    if (!autoRefreshLogs) {
      return;
    }
    fetchLogs();
    const interval = window.setInterval(fetchLogs, 2000);
    return () => window.clearInterval(interval);
  }, [autoRefreshLogs, apiUrlValue]);

  useEffect(() => {
    if (!availableTools.length || !toolName) {
      return;
    }
    const selectedTool = availableTools.find((tool) => tool.name === toolName);
    if (!selectedTool || !selectedTool.inputSchema) {
      return;
    }
    const template = buildJsonTemplate(selectedTool.inputSchema);
    setToolArguments(JSON.stringify(template, null, 2));
  }, [availableTools, toolName]);

  const parseJson = (value: string, label: string) => {
    if (!value.trim()) {
      return {};
    }
    try {
      return JSON.parse(value);
    } catch (parseError) {
      const errorMsg = `Invalid JSON in ${label}: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`;
      addLocalLog({ direction: 'error', payload: errorMsg });
      return null;
    }
  };

  const buildJsonTemplate = (schema: any): any => {
    if (!schema || typeof schema !== 'object') {
      return {};
    }
    if (schema.default !== undefined) {
      return schema.default;
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum[0];
    }
    if (schema.type === 'object' || schema.properties) {
      const properties = schema.properties || {};
      const result: Record<string, any> = {};
      Object.entries(properties).forEach(([key, value]) => {
        result[key] = buildJsonTemplate(value);
      });
      return result;
    }
    if (schema.type === 'array') {
      return [];
    }
    if (schema.type === 'boolean') {
      return false;
    }
    if (schema.type === 'number' || schema.type === 'integer') {
      return 0;
    }
    if (schema.type === 'string') {
      return '';
    }
    return {};
  };

  const buildHeaders = () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKeyValue.trim()) {
      headers.Authorization = `Bearer ${apiKeyValue.trim()}`;
    }
    return headers;
  };

  const handleResponse = (method: string, data: any) => {
    if (data?.result) {
      if (method === 'initialize') {
        setIsInitialized(true);
        setServerName(data.result.serverInfo?.name || null);
        setServerVersion(data.result.serverInfo?.version || null);
      }
      if (method === 'tools/list' && data.result.tools) {
        setAvailableTools(data.result.tools);
        if (!toolName && data.result.tools.length > 0) {
          setToolName(data.result.tools[0].name);
        }
      }
      if (method === 'resources/list' && data.result.resources) {
        setAvailableResources(data.result.resources);
        if (!resourceUri && data.result.resources.length > 0) {
          setResourceUri(data.result.resources[0].uri);
        }
      }
      if (method === 'prompts/list' && data.result.prompts) {
        setAvailablePrompts(data.result.prompts);
        if (!promptName && data.result.prompts.length > 0) {
          setPromptName(data.result.prompts[0].name);
        }
      }
    }
  };

  const sendMcpRequest = async (method: string, params: object) => {
    setLoading(true);

    try {
      const requestBody = {
        jsonrpc: '2.0',
        id: requestId,
        method,
        params
      };
      setRequestId((prev) => prev + 1);

      const res = await fetch(resolveEndpoint(apiUrlValue, '/mcp'), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(requestBody)
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
      if (data) {
        handleResponse(method, data);
        fetchLogs();
      } else {
        const text = await res.text();
        if (text) {
          addLocalLog({ direction: 'incoming', payload: text });
        }
        fetchLogs();
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
          if (err.message.includes('CORS') || err.message.includes('Access to fetch')) {
            addLocalLog({
              direction: 'error',
              payload: `CORS Error: ${err.message}\n\nIf this is a local MCP server:\n- Enable CORS on the server\n- Or route requests through the local proxy on port 3001`
            });
          } else {
            addLocalLog({
              direction: 'error',
              payload: `Network Error: ${err.message}\n\nMake sure the MCP server is running and reachable.`
            });
          }
        } else {
          addLocalLog({ direction: 'error', payload: `Request Error: ${err.message}` });
        }
      } else {
        addLocalLog({ direction: 'error', payload: 'An unknown error occurred' });
      }
    } finally {
      setLoading(false);
    }
  };

  const sendNotification = async (method: string) => {
    setLoading(true);

    try {
      const requestBody = {
        jsonrpc: '2.0',
        method
      };

      const res = await fetch(resolveEndpoint(apiUrlValue, '/mcp'), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(requestBody)
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
      if (err instanceof Error) {
        addLocalLog({ direction: 'error', payload: `Request Error: ${err.message}` });
      } else {
        addLocalLog({ direction: 'error', payload: 'An unknown error occurred' });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAdvancedSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseJson(advancedParams, 'advanced parameters');
    if (parsed === null) {
      return;
    }
    sendMcpRequest(advancedMethod, parsed);
  };

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
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Stage 1: Initialize</h2>
            <p className="text-sm text-gray-500 mt-1">
              {methodDescriptions.initialize}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
              isInitialized ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
            }`}>
              <span className={`w-2 h-2 rounded-full mr-2 ${isInitialized ? 'bg-green-500' : 'bg-gray-400'}`}></span>
              {isInitialized ? 'Connected' : 'Not Connected'}
            </span>
            {serverName && (
              <span className="text-sm text-gray-500">
                {serverName}{serverVersion ? ` v${serverVersion}` : ''}
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => sendMcpRequest('initialize', defaultInitParams)}
            disabled={loading}
            className={`px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Initialize
          </button>
          <button
            type="button"
            onClick={() => sendNotification('notifications/initialized')}
            disabled={loading}
            className={`px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Send Initialized Notification
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700">Stage 2: Discover</h2>
        <p className="text-sm text-gray-500 mt-1">
          Fetch the server catalog so you can pick tools, resources, and prompts.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => sendMcpRequest('tools/list', {})}
            disabled={loading}
            className={`px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            List Tools ({availableTools.length})
          </button>
          <button
            type="button"
            onClick={() => sendMcpRequest('resources/list', {})}
            disabled={loading}
            className={`px-4 py-2 bg-amber-500 text-white rounded-md hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            List Resources ({availableResources.length})
          </button>
          <button
            type="button"
            onClick={() => sendMcpRequest('prompts/list', {})}
            disabled={loading}
            className={`px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            List Prompts ({availablePrompts.length})
          </button>
          <button
            type="button"
            onClick={() => sendMcpRequest('ping', {})}
            disabled={loading}
            className={`px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Ping
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700">Stage 3: Use Capabilities</h2>
        <div className="mt-4 flex flex-wrap gap-2 border-b border-gray-200">
          {[
            { id: 'tools', label: `Tools (${availableTools.length})` },
            { id: 'resources', label: `Resources (${availableResources.length})` },
            { id: 'prompts', label: `Prompts (${availablePrompts.length})` }
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStage3Tab(tab.id as 'tools' | 'resources' | 'prompts')}
              className={`px-4 py-2 text-sm font-medium border-b-2 ${
                stage3Tab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {stage3Tab === 'tools' && (
          <div className="mt-6 border border-gray-200 rounded-lg p-5">
            <h3 className="text-lg font-semibold text-gray-700">Tools</h3>
            <p className="text-xs text-gray-500 mt-1">{methodDescriptions['tools/call']}</p>
            <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Tool</label>
            {availableTools.length > 0 ? (
              <select
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {availableTools.map((tool) => (
                  <option key={tool.name} value={tool.name}>
                    {tool.title || tool.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="tool_name"
              />
            )}
            {availableTools.length > 0 && (
              <div className="mt-2 text-xs text-gray-600">
                <div className="font-semibold text-gray-700">
                  {(availableTools.find((tool) => tool.name === toolName)?.title) || toolName}
                </div>
                <div className="font-mono text-gray-500">
                  {availableTools.find((tool) => tool.name === toolName)?.name || toolName}
                </div>
                {availableTools.find((tool) => tool.name === toolName)?.description && (
                  <p className="mt-1 text-gray-600">
                    {availableTools.find((tool) => tool.name === toolName)?.description}
                  </p>
                )}
              </div>
            )}
            {availableTools.length > 0 && availableTools.find((tool) => tool.name === toolName)?.inputSchema && (
              <div className="mt-3 bg-blue-50 border border-blue-200 rounded-md p-3">
                <div className="text-xs font-semibold text-blue-700 mb-2">Tool Parameters</div>
                <ul className="space-y-2 text-xs text-blue-900 max-h-40 overflow-auto">
                  {(() => {
                    const schema = availableTools.find((tool) => tool.name === toolName)?.inputSchema as any;
                    const properties = schema?.properties || {};
                    const required = new Set<string>(schema?.required || []);
                    const entries = Object.entries(properties);
                    if (!entries.length) {
                      return <li className="text-blue-800">No parameters defined.</li>;
                    }
                    return entries.map(([name, value]) => {
                      const type = (value as any)?.type || 'any';
                      const description = (value as any)?.description;
                      const enumValues = Array.isArray((value as any)?.enum) ? (value as any).enum : null;
                      return (
                        <li key={name} className="border border-blue-100 rounded-md p-2 bg-white/60">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-blue-900">{name}</span>
                            <span className="text-[11px] text-blue-700">({type})</span>
                            {required.has(name) && (
                              <span className="text-[11px] text-blue-700 font-semibold">required</span>
                            )}
                          </div>
                          {description && (
                            <div className="mt-1 text-blue-800">{description}</div>
                          )}
                          {enumValues && (
                            <div className="mt-1 text-[11px] text-blue-700">
                              Options: {enumValues.join(', ')}
                            </div>
                          )}
                        </li>
                      );
                    });
                  })()}
                </ul>
              </div>
            )}
            <label className="block text-xs font-medium text-gray-600 mt-3 mb-1">Tool Arguments (JSON)</label>
            <textarea
              value={toolArguments}
              onChange={(e) => setToolArguments(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-40 text-xs"
              placeholder="{}"
            />
            <button
              type="button"
              onClick={() => {
                const parsed = parseJson(toolArguments, 'tool arguments');
                if (parsed === null) return;
                sendMcpRequest('tools/call', { name: toolName || 'tool_name', arguments: parsed });
              }}
              disabled={loading}
              className={`mt-3 inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Call Tool
            </button>
          </div>
        )}

        {stage3Tab === 'resources' && (
          <div className="mt-6 border border-gray-200 rounded-lg p-5">
            <h3 className="text-lg font-semibold text-gray-700">Resources</h3>
            <p className="text-xs text-gray-500 mt-1">{methodDescriptions['resources/read']}</p>
            <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Resource URI</label>
            {availableResources.length > 0 ? (
              <select
                value={resourceUri}
                onChange={(e) => setResourceUri(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {availableResources.map((resource) => (
                  <option key={resource.uri} value={resource.uri}>
                    {resource.name} ({resource.uri})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={resourceUri}
                onChange={(e) => setResourceUri(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="file:///path/to/resource"
              />
            )}
            {availableResources.length > 0 && (
              <div className="mt-2 text-xs text-gray-600">
                <div className="font-semibold text-gray-700">
                  {availableResources.find((resource) => resource.uri === resourceUri)?.name || resourceUri}
                </div>
                <div className="font-mono text-gray-500 break-all">
                  {availableResources.find((resource) => resource.uri === resourceUri)?.uri || resourceUri}
                </div>
                {availableResources.find((resource) => resource.uri === resourceUri)?.description && (
                  <p className="mt-1 text-gray-600">
                    {availableResources.find((resource) => resource.uri === resourceUri)?.description}
                  </p>
                )}
                {availableResources.find((resource) => resource.uri === resourceUri)?.mimeType && (
                  <p className="mt-1 text-gray-500">
                    {availableResources.find((resource) => resource.uri === resourceUri)?.mimeType}
                  </p>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => sendMcpRequest('resources/read', { uri: resourceUri || 'file:///path/to/resource' })}
              disabled={loading}
              className={`mt-6 w-full px-4 py-2 bg-amber-500 text-white rounded-md hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Read Resource
            </button>
          </div>
        )}

        {stage3Tab === 'prompts' && (
          <div className="mt-6 border border-gray-200 rounded-lg p-5">
            <h3 className="text-lg font-semibold text-gray-700">Prompts</h3>
            <p className="text-xs text-gray-500 mt-1">{methodDescriptions['prompts/get']}</p>
            <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Prompt</label>
            {availablePrompts.length > 0 ? (
              <select
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {availablePrompts.map((prompt) => (
                  <option key={prompt.name} value={prompt.name}>
                    {prompt.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="prompt_name"
              />
            )}
            {availablePrompts.length > 0 && (
              <div className="mt-2 text-xs text-gray-600">
                <div className="font-semibold text-gray-700">
                  {availablePrompts.find((prompt) => prompt.name === promptName)?.name || promptName}
                </div>
                {availablePrompts.find((prompt) => prompt.name === promptName)?.description && (
                  <p className="mt-1 text-gray-600">
                    {availablePrompts.find((prompt) => prompt.name === promptName)?.description}
                  </p>
                )}
                {availablePrompts.find((prompt) => prompt.name === promptName)?.arguments &&
                  availablePrompts.find((prompt) => prompt.name === promptName)?.arguments?.length ? (
                    <p className="mt-1 text-gray-500">
                      Args: {availablePrompts.find((prompt) => prompt.name === promptName)?.arguments?.map((arg) => arg.name).join(', ')}
                    </p>
                  ) : null}
              </div>
            )}
            <label className="block text-xs font-medium text-gray-600 mt-3 mb-1">Prompt Arguments (JSON)</label>
            <textarea
              value={promptArguments}
              onChange={(e) => setPromptArguments(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-40 text-xs"
              placeholder="{}"
            />
            <button
              type="button"
              onClick={() => {
                const parsed = parseJson(promptArguments, 'prompt arguments');
                if (parsed === null) return;
                sendMcpRequest('prompts/get', { name: promptName || 'prompt_name', arguments: parsed });
              }}
              disabled={loading}
              className={`mt-3 w-full px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Get Prompt
            </button>
          </div>
        )}
      </div>

      <details className="bg-white rounded-lg shadow-md p-6 mb-6">
        <summary className="text-lg font-semibold text-gray-700 cursor-pointer">Advanced JSON-RPC</summary>
        <p className="text-sm text-gray-500 mt-2">
          Use this section for custom methods or raw JSON-RPC requests.
        </p>
        <form onSubmit={handleAdvancedSubmit} className="mt-4">
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">MCP Method</label>
            <div className="flex items-center space-x-2">
              <select
                value={advancedMethod}
                onChange={(e) => setAdvancedMethod(e.target.value)}
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
                value={advancedMethod}
                onChange={(e) => setAdvancedMethod(e.target.value)}
                className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter custom method path"
              />
            )}
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Method Description</label>
            <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-md text-xs">
              {methodDescriptions[advancedMethod] || 'No description available for this method.'}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">Request Parameters (JSON)</label>
            <textarea
              value={advancedParams}
              onChange={(e) => setAdvancedParams(e.target.value)}
              placeholder="{}"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-40 text-xs"
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
      </details>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Live Log</h2>
            <p className="text-sm text-gray-500 mt-1">
              Mirrors the MCP CLI output, including requests, responses, and notifications.
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

export default MCPTester;
