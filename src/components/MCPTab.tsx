import React, { useState, useRef, useEffect } from 'react';

interface Message {
  id: number;
  type: 'request' | 'response' | 'error' | 'notification';
  method?: string;
  content: string;
  timestamp: Date;
  jsonData?: object;
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

const MCPTab: React.FC = () => {
  const [endpoint, setEndpoint] = useState('http://localhost:3001');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [showJson, setShowJson] = useState(true);
  const [selectedMethod, setSelectedMethod] = useState('initialize');
  const [customParams, setCustomParams] = useState('');
  const [messageId, setMessageId] = useState(1);
  const [isInitialized, setIsInitialized] = useState(false);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [availableResources, setAvailableResources] = useState<Resource[]>([]);
  const [availablePrompts, setAvailablePrompts] = useState<Prompt[]>([]);
  const [selectedTool, setSelectedTool] = useState('');
  const [selectedResource, setSelectedResource] = useState('');
  const [selectedPrompt, setSelectedPrompt] = useState('');
  const [toolArguments, setToolArguments] = useState('{}');
  const [promptArguments, setPromptArguments] = useState('{}');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const mcpMethods = [
    { value: 'initialize', label: 'Initialize Connection', category: 'Lifecycle' },
    { value: 'tools/list', label: 'List Tools', category: 'Tools' },
    { value: 'tools/call', label: 'Call Tool', category: 'Tools' },
    { value: 'resources/list', label: 'List Resources', category: 'Resources' },
    { value: 'resources/read', label: 'Read Resource', category: 'Resources' },
    { value: 'prompts/list', label: 'List Prompts', category: 'Prompts' },
    { value: 'prompts/get', label: 'Get Prompt', category: 'Prompts' },
    { value: 'ping', label: 'Ping', category: 'Utility' },
  ];

  const methodDescriptions: Record<string, string> = {
    'initialize': 'Establishes connection with the MCP server and negotiates capabilities. This must be called first before any other operations.',
    'tools/list': 'Discovers all available tools on the MCP server. Tools are functions that can be called to perform actions.',
    'tools/call': 'Executes a specific tool with the provided arguments. Select a tool from the discovered tools list.',
    'resources/list': 'Lists all available resources on the server. Resources are data sources that can be read.',
    'resources/read': 'Retrieves the content of a specific resource by its URI.',
    'prompts/list': 'Lists all available prompt templates on the server.',
    'prompts/get': 'Retrieves a specific prompt template with the provided arguments.',
    'ping': 'Simple ping to check if the server is responsive.',
  };

  const getDefaultParams = (method: string): object => {
    switch (method) {
      case 'initialize':
        return {
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
      case 'tools/list':
      case 'resources/list':
      case 'prompts/list':
      case 'ping':
        return {};
      case 'tools/call':
        return {
          name: selectedTool || 'tool_name',
          arguments: JSON.parse(toolArguments || '{}')
        };
      case 'resources/read':
        return {
          uri: selectedResource || 'file:///path/to/resource'
        };
      case 'prompts/get':
        return {
          name: selectedPrompt || 'prompt_name',
          arguments: JSON.parse(promptArguments || '{}')
        };
      default:
        return {};
    }
  };

  const buildJsonRpcRequest = (method: string, params: object) => {
    const id = messageId;
    setMessageId(prev => prev + 1);
    return {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    try {
      const params = getDefaultParams(selectedMethod);
      setCustomParams(JSON.stringify(params, null, 2));
    } catch {
      // Keep current params if there's an error
    }
  }, [selectedMethod, selectedTool, selectedResource, selectedPrompt, toolArguments, promptArguments]);

  const addMessage = (msg: Omit<Message, 'id' | 'timestamp'>) => {
    setMessages(prev => [...prev, {
      ...msg,
      id: Date.now(),
      timestamp: new Date()
    }]);
  };

  const sendRequest = async () => {
    setLoading(true);

    try {
      let params: object;
      try {
        params = customParams ? JSON.parse(customParams) : getDefaultParams(selectedMethod);
      } catch (e) {
        addMessage({
          type: 'error',
          content: `Invalid JSON in parameters: ${e instanceof Error ? e.message : 'Unknown error'}`,
        });
        setLoading(false);
        return;
      }

      const request = buildJsonRpcRequest(selectedMethod, params);

      addMessage({
        type: 'request',
        method: selectedMethod,
        content: `Sending ${selectedMethod} request...`,
        jsonData: request
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request)
      });

      const data = await response.json();

      if (data.error) {
        addMessage({
          type: 'error',
          method: selectedMethod,
          content: `Error: ${data.error.message || JSON.stringify(data.error)}`,
          jsonData: data
        });
      } else {
        addMessage({
          type: 'response',
          method: selectedMethod,
          content: getResponseSummary(selectedMethod, data.result),
          jsonData: data
        });

        // Update state based on response
        if (selectedMethod === 'initialize' && data.result) {
          setIsInitialized(true);
          // Send initialized notification
          const notification = {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          };
          await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notification)
          });
          addMessage({
            type: 'notification',
            method: 'notifications/initialized',
            content: 'Sent initialized notification',
            jsonData: notification
          });
        } else if (selectedMethod === 'tools/list' && data.result?.tools) {
          setAvailableTools(data.result.tools);
          if (data.result.tools.length > 0) {
            setSelectedTool(data.result.tools[0].name);
          }
        } else if (selectedMethod === 'resources/list' && data.result?.resources) {
          setAvailableResources(data.result.resources);
          if (data.result.resources.length > 0) {
            setSelectedResource(data.result.resources[0].uri);
          }
        } else if (selectedMethod === 'prompts/list' && data.result?.prompts) {
          setAvailablePrompts(data.result.prompts);
          if (data.result.prompts.length > 0) {
            setSelectedPrompt(data.result.prompts[0].name);
          }
        }
      }
    } catch (err) {
      addMessage({
        type: 'error',
        content: `Network Error: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure the MCP server is running and accessible.`,
      });
    } finally {
      setLoading(false);
    }
  };

  const getResponseSummary = (method: string, result: any): string => {
    if (!result) return 'Empty response';

    switch (method) {
      case 'initialize':
        return `Connected to ${result.serverInfo?.name || 'MCP Server'} v${result.serverInfo?.version || 'unknown'}`;
      case 'tools/list':
        return `Found ${result.tools?.length || 0} tools available`;
      case 'tools/call':
        if (result.content?.[0]?.text) {
          return result.content[0].text.substring(0, 200) + (result.content[0].text.length > 200 ? '...' : '');
        }
        return 'Tool executed successfully';
      case 'resources/list':
        return `Found ${result.resources?.length || 0} resources available`;
      case 'resources/read':
        if (result.contents?.[0]?.text) {
          return `Resource content (${result.contents[0].mimeType || 'text'}): ${result.contents[0].text.substring(0, 100)}...`;
        }
        return 'Resource read successfully';
      case 'prompts/list':
        return `Found ${result.prompts?.length || 0} prompts available`;
      case 'prompts/get':
        return `Prompt retrieved with ${result.messages?.length || 0} messages`;
      case 'ping':
        return 'Pong! Server is responsive';
      default:
        return 'Response received';
    }
  };

  const clearMessages = () => {
    setMessages([]);
    setIsInitialized(false);
    setAvailableTools([]);
    setAvailableResources([]);
    setAvailablePrompts([]);
    setMessageId(1);
  };

  const getMessageIcon = (type: Message['type']) => {
    switch (type) {
      case 'request':
        return (
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </div>
        );
      case 'response':
        return (
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        );
      case 'error':
        return (
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        );
      case 'notification':
        return (
          <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </div>
        );
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-800 mb-6">MCP (Model Context Protocol) Tester</h1>

        {/* Configuration Section */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">MCP Server Endpoint</label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="http://localhost:3001"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex items-center">
                <span className={`inline-flex items-center px-3 py-2 rounded-full text-sm font-medium ${
                  isInitialized ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                }`}>
                  <span className={`w-2 h-2 rounded-full mr-2 ${isInitialized ? 'bg-green-500' : 'bg-gray-400'}`}></span>
                  {isInitialized ? 'Connected' : 'Not Connected'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Panel - Method Selection & Parameters */}
          <div className="lg:col-span-1 space-y-6">
            {/* Method Selection */}
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-700 mb-4">Method</h2>
              <select
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
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

              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-700">
                {methodDescriptions[selectedMethod]}
              </div>
            </div>

            {/* Dynamic Parameters based on method */}
            {selectedMethod === 'tools/call' && availableTools.length > 0 && (
              <div className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-lg font-semibold text-gray-700 mb-4">Select Tool</h2>
                <select
                  value={selectedTool}
                  onChange={(e) => setSelectedTool(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
                >
                  {availableTools.map((tool) => (
                    <option key={tool.name} value={tool.name}>
                      {tool.title || tool.name}
                    </option>
                  ))}
                </select>
                {availableTools.find(t => t.name === selectedTool)?.description && (
                  <p className="text-sm text-gray-600 mb-3">
                    {availableTools.find(t => t.name === selectedTool)?.description}
                  </p>
                )}
                <label className="block text-sm font-medium text-gray-600 mb-1">Tool Arguments (JSON)</label>
                <textarea
                  value={toolArguments}
                  onChange={(e) => setToolArguments(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-24 font-mono text-sm"
                  placeholder="{}"
                />
              </div>
            )}

            {selectedMethod === 'resources/read' && availableResources.length > 0 && (
              <div className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-lg font-semibold text-gray-700 mb-4">Select Resource</h2>
                <select
                  value={selectedResource}
                  onChange={(e) => setSelectedResource(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {availableResources.map((resource) => (
                    <option key={resource.uri} value={resource.uri}>
                      {resource.name} ({resource.uri})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedMethod === 'prompts/get' && availablePrompts.length > 0 && (
              <div className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-lg font-semibold text-gray-700 mb-4">Select Prompt</h2>
                <select
                  value={selectedPrompt}
                  onChange={(e) => setSelectedPrompt(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
                >
                  {availablePrompts.map((prompt) => (
                    <option key={prompt.name} value={prompt.name}>
                      {prompt.name}
                    </option>
                  ))}
                </select>
                {availablePrompts.find(p => p.name === selectedPrompt)?.arguments && (
                  <>
                    <label className="block text-sm font-medium text-gray-600 mb-1">Prompt Arguments (JSON)</label>
                    <textarea
                      value={promptArguments}
                      onChange={(e) => setPromptArguments(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-24 font-mono text-sm"
                      placeholder="{}"
                    />
                  </>
                )}
              </div>
            )}

            {/* Raw JSON Parameters */}
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-700 mb-4">Request Parameters</h2>
              <textarea
                value={customParams}
                onChange={(e) => setCustomParams(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-40 font-mono text-sm"
                placeholder="{}"
              />
              <div className="mt-4 flex gap-2">
                <button
                  onClick={sendRequest}
                  disabled={loading}
                  className={`flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    loading ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  {loading ? (
                    <span className="flex items-center justify-center">
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Sending...
                    </span>
                  ) : (
                    'Send Request'
                  )}
                </button>
                <button
                  onClick={clearMessages}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>

          {/* Right Panel - Chat-like Message View */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow-md h-[700px] flex flex-col">
              {/* Header */}
              <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                <h2 className="text-lg font-semibold text-gray-700">Message Log</h2>
                <div className="flex items-center gap-4">
                  <label className="flex items-center cursor-pointer">
                    <span className="text-sm text-gray-600 mr-2">Show JSON</span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={showJson}
                        onChange={(e) => setShowJson(e.target.checked)}
                        className="sr-only"
                      />
                      <div className={`w-10 h-6 rounded-full transition-colors ${showJson ? 'bg-blue-600' : 'bg-gray-300'}`}>
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${showJson ? 'translate-x-5' : 'translate-x-1'}`}></div>
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Messages Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <p className="text-lg font-medium">No messages yet</p>
                    <p className="text-sm mt-1">Start by sending an initialize request</p>
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex gap-3 ${message.type === 'request' ? 'flex-row-reverse' : ''}`}
                    >
                      {getMessageIcon(message.type)}
                      <div className={`flex-1 max-w-[85%] ${message.type === 'request' ? 'text-right' : ''}`}>
                        <div className="flex items-center gap-2 mb-1">
                          {message.type !== 'request' && (
                            <span className={`text-xs font-medium uppercase ${
                              message.type === 'response' ? 'text-green-600' :
                              message.type === 'error' ? 'text-red-600' :
                              'text-purple-600'
                            }`}>
                              {message.type}
                            </span>
                          )}
                          {message.method && (
                            <span className="text-xs text-gray-500 font-mono bg-gray-100 px-2 py-0.5 rounded">
                              {message.method}
                            </span>
                          )}
                          {message.type === 'request' && (
                            <span className="text-xs font-medium uppercase text-blue-600">
                              {message.type}
                            </span>
                          )}
                          <span className="text-xs text-gray-400">{formatTime(message.timestamp)}</span>
                        </div>
                        <div className={`rounded-lg p-3 ${
                          message.type === 'request' ? 'bg-blue-50 border border-blue-200' :
                          message.type === 'response' ? 'bg-green-50 border border-green-200' :
                          message.type === 'error' ? 'bg-red-50 border border-red-200' :
                          'bg-purple-50 border border-purple-200'
                        }`}>
                          <p className={`text-sm ${
                            message.type === 'error' ? 'text-red-700' : 'text-gray-700'
                          }`}>
                            {message.content}
                          </p>
                          {showJson && message.jsonData && (
                            <details className="mt-2">
                              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                                View JSON
                              </summary>
                              <pre className="mt-2 p-2 bg-gray-800 text-gray-100 rounded text-xs overflow-x-auto max-h-60">
                                {JSON.stringify(message.jsonData, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Quick Actions Footer */}
              {messages.length > 0 && (
                <div className="px-6 py-3 border-t border-gray-200 bg-gray-50">
                  <div className="flex gap-2 flex-wrap">
                    <span className="text-xs text-gray-500 self-center mr-2">Quick actions:</span>
                    {!isInitialized && (
                      <button
                        onClick={() => { setSelectedMethod('initialize'); setTimeout(sendRequest, 100); }}
                        className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200"
                      >
                        Initialize
                      </button>
                    )}
                    {isInitialized && (
                      <>
                        <button
                          onClick={() => { setSelectedMethod('tools/list'); setTimeout(sendRequest, 100); }}
                          className="px-3 py-1 text-xs bg-green-100 text-green-700 rounded-full hover:bg-green-200"
                        >
                          List Tools
                        </button>
                        <button
                          onClick={() => { setSelectedMethod('resources/list'); setTimeout(sendRequest, 100); }}
                          className="px-3 py-1 text-xs bg-yellow-100 text-yellow-700 rounded-full hover:bg-yellow-200"
                        >
                          List Resources
                        </button>
                        <button
                          onClick={() => { setSelectedMethod('prompts/list'); setTimeout(sendRequest, 100); }}
                          className="px-3 py-1 text-xs bg-purple-100 text-purple-700 rounded-full hover:bg-purple-200"
                        >
                          List Prompts
                        </button>
                        <button
                          onClick={() => { setSelectedMethod('ping'); setTimeout(sendRequest, 100); }}
                          className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded-full hover:bg-gray-200"
                        >
                          Ping
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Discovered Items Summary */}
            {(availableTools.length > 0 || availableResources.length > 0 || availablePrompts.length > 0) && (
              <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                {availableTools.length > 0 && (
                  <div className="bg-white rounded-lg shadow-md p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center">
                      <span className="w-2 h-2 bg-green-500 rounded-full mr-2"></span>
                      Tools ({availableTools.length})
                    </h3>
                    <ul className="text-xs text-gray-600 space-y-1 max-h-32 overflow-y-auto">
                      {availableTools.map((tool) => (
                        <li key={tool.name} className="truncate" title={tool.description}>
                          {tool.title || tool.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {availableResources.length > 0 && (
                  <div className="bg-white rounded-lg shadow-md p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center">
                      <span className="w-2 h-2 bg-yellow-500 rounded-full mr-2"></span>
                      Resources ({availableResources.length})
                    </h3>
                    <ul className="text-xs text-gray-600 space-y-1 max-h-32 overflow-y-auto">
                      {availableResources.map((resource) => (
                        <li key={resource.uri} className="truncate" title={resource.uri}>
                          {resource.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {availablePrompts.length > 0 && (
                  <div className="bg-white rounded-lg shadow-md p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center">
                      <span className="w-2 h-2 bg-purple-500 rounded-full mr-2"></span>
                      Prompts ({availablePrompts.length})
                    </h3>
                    <ul className="text-xs text-gray-600 space-y-1 max-h-32 overflow-y-auto">
                      {availablePrompts.map((prompt) => (
                        <li key={prompt.name} className="truncate" title={prompt.description}>
                          {prompt.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MCPTab;
