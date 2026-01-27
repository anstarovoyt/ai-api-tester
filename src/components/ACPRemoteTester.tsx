import React, { useEffect, useMemo, useRef, useState } from 'react';
import PrettySelect from './PrettySelect';

interface ACPRemoteTesterProps {
  apiUrl: string;
  apiKey: string;
}

interface LogEntry {
  id: number;
  timestamp: string;
  direction: 'outgoing' | 'incoming' | 'notification' | 'raw' | 'error';
  payload: any;
}

interface MethodConfig {
  template: string;
  description: string;
}

interface ModelOption {
  modelId: string;
  name: string;
  description?: string;
}

interface ModeOption {
  id: string;
  name: string;
  description?: string;
}

interface ChatMessage {
  id: string;
  role: 'agent' | 'user' | 'system';
  content: string;
  timestamp: string;
  sessionId: string;
}

interface RemoteTarget {
  url: string;
  branch: string;
  revision: string;
}

const REQUEST_TIMEOUT_MS = 60_000;

const methodConfigs: Record<string, MethodConfig> = {
  'initialize': {
    template: `{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": {
      "readTextFile": false,
      "writeTextFile": false
    },
    "terminal": false
  },
  "clientInfo": {
    "name": "acp-remote-tester",
    "version": "1.0.0"
  }
}`,
    description: 'Negotiates protocol compatibility and exchanges capabilities over WebSocket. Run this first to learn what the agent supports, and to confirm the negotiated <span class="font-semibold">protocolVersion</span>.'
  },
  'authenticate': {
    template: `{
  "methodId": "auth_method_id"
}`,
    description: 'Authenticates the client with the agent when required. Use this only if the agent requests authentication during initialization.'
  },
  'session/new': {
    template: `{
  "cwd": "",
  "mcpServers": [],
  "_meta": {
    "remote": {
      "url": "git@github.com:user/repo.git",
      "branch": "main",
      "revision": "abc123def456..."
    }
  }
}`,
    description: 'Creates a new remote ACP session. Include <span class="font-semibold">_meta.remote</span> with the git URL, branch, and revision. The agent should respond with <span class="font-semibold">_meta.target</span> describing the branch it pushed to.'
  },
  'session/load': {
    template: `{
  "sessionId": "sess_abc123def456",
  "cwd": "",
  "mcpServers": []
}`,
    description: 'Loads an existing ACP session if the agent supports <span class="font-semibold">loadSession</span>.'
  },
  'session/prompt': {
    template: `{
  "sessionId": "sess_abc123def456",
  "prompt": [
    {
      "type": "text",
      "text": "Hello from the remote client"
    }
  ]
}`,
    description: 'Sends a prompt within an active session. The agent replies with <span class="font-semibold">session/update</span> notifications until the turn completes.'
  },
  'session/cancel': {
    template: `{
  "sessionId": "sess_abc123def456"
}`,
    description: 'Cancels an in-flight prompt turn for a session. This is a notification (no response expected).'
  },
  'session/set_mode': {
    template: `{
  "sessionId": "sess_abc123def456",
  "modeId": "code"
}`,
    description: 'Switches the current mode for an active session.'
  },
  'session/set_model': {
    template: `{
  "sessionId": "sess_abc123def456",
  "modelId": "opencode/big-pickle"
}`,
    description: '<span class="font-semibold">UNSTABLE</span> - Switches the active model for the current session.'
  },
  'ping': {
    template: '{}',
    description: 'Checks ACP agent connectivity and measures basic responsiveness.'
  }
};

const endpointMethods = [
  { value: 'initialize', label: 'Initialize' },
  { value: 'authenticate', label: 'Authenticate' }
];

const sessionMethods = [
  { value: 'session/prompt', label: 'Session Prompt' },
  { value: 'session/set_mode', label: 'Session Set Mode' },
  { value: 'session/cancel', label: 'Session Cancel (notification)' }
];

const apiUrlOptions = [
  'ws://localhost:3001/acp',
  'ws://localhost:3001'
];

const ACPRemoteTester: React.FC<ACPRemoteTesterProps> = ({ apiUrl, apiKey }) => {
  const [params, setParams] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiUrlValue, setApiUrlValue] = useState(apiUrl);
  const [apiKeyValue, setApiKeyValue] = useState(apiKey);
  const [selectedMethod, setSelectedMethod] = useState(endpointMethods[0].value);
  const [showMethodInput, setShowMethodInput] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [requestId, setRequestId] = useState(1);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionCommand, setSessionCommand] = useState<'session/new' | 'session/load'>('session/new');
  const [sessionMethod, setSessionMethod] = useState(sessionMethods[0].value);
  const [sessionParams, setSessionParams] = useState(methodConfigs[sessionMethods[0].value].template);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [availableModes, setAvailableModes] = useState<ModeOption[]>([]);
  const [selectedModeId, setSelectedModeId] = useState('');
  const [pendingPrompts, setPendingPrompts] = useState<Set<number>>(new Set());
  const [remoteGitInfo, setRemoteGitInfo] = useState({ url: '', branch: '', revision: '' });
  const [remoteMetaEnabled, setRemoteMetaEnabled] = useState(true);
  const [remoteTarget, setRemoteTarget] = useState<RemoteTarget | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRequestsRef = useRef<Map<number | string, (payload: any) => void>>(new Map());
  const pendingTimeoutsRef = useRef<Map<number | string, number>>(new Map());
  const requestTimingsRef = useRef<Map<number | string, number>>(new Map());
  const logCounterRef = useRef(1);
  const autoModelSessionRef = useRef<string | null>(null);

  const buildSessionRequestTemplate = (method: 'session/new' | 'session/load') => {
    const paramsTemplate = methodConfigs[method]?.template || '{}';
    return `{\n  \"jsonrpc\": \"2.0\",\n  \"id\": ${requestId},\n  \"method\": \"${method}\",\n  \"params\": ${paramsTemplate}\n}`;
  };

  const [sessionInitParams, setSessionInitParams] = useState(buildSessionRequestTemplate('session/new'));

  const apiUrlChoices = useMemo(() => (
    apiUrlOptions.includes(apiUrlValue)
      ? apiUrlOptions
      : [...apiUrlOptions, apiUrlValue]
  ), [apiUrlValue]);

  const addLocalLog = (entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
    const id = logCounterRef.current++;
    setLogEntries((prev) => {
      const next = [
        ...prev,
        {
          id,
          timestamp: new Date().toISOString(),
          ...entry
        }
      ];
      if (next.length > 500) {
        return next.slice(next.length - 500);
      }
      return next;
    });
  };

  const formatContentBlock = (content: any) => {
    if (!content) {
      return '';
    }
    if (Array.isArray(content)) {
      return content.map((item) => formatContentBlock(item)).filter(Boolean).join('\n');
    }
    switch (content.type) {
      case 'text':
        return content.text || '';
      case 'resource_link':
        return `Resource link: ${content.name || 'resource'}${content.uri ? ` (${content.uri})` : ''}`;
      case 'resource': {
        const resource = content.resource || {};
        if (resource.text) {
          return `Resource: ${resource.uri || 'embedded'}\n${resource.text}`;
        }
        if (resource.blob) {
          return `Resource: ${resource.uri || 'embedded'} (${resource.mimeType || 'binary'})`;
        }
        return `Resource: ${resource.uri || 'embedded'}`;
      }
      case 'image':
        return `Image: ${content.mimeType || 'image'}${content.uri ? ` (${content.uri})` : ''}`;
      case 'audio':
        return `Audio: ${content.mimeType || 'audio'}`;
      default:
        return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    }
  };

  const chatMessages = useMemo<ChatMessage[]>(() => {
    const messages: ChatMessage[] = [];
    const activeIndexByKey = new Map<string, number>();
    const forceNewByKey = new Map<string, boolean>();
    const appendContent = (existing: string, incoming: string) => {
      const trimmedIncoming = incoming.trim();
      if (!existing) {
        return trimmedIncoming;
      }
      if (!trimmedIncoming) {
        return existing;
      }
      const trimmedExisting = existing.trim();
      if (trimmedIncoming.startsWith(trimmedExisting)) {
        return trimmedIncoming;
      }
      if (trimmedExisting.startsWith(trimmedIncoming)) {
        return trimmedExisting;
      }
      const noSpacePrefix = /^[,.:;!?]/.test(trimmedIncoming);
      const needsSpace = !/\s$/.test(existing) && !noSpacePrefix;
      return `${existing}${needsSpace ? ' ' : ''}${trimmedIncoming}`;
    };
    logEntries.forEach((entry) => {
      if (entry.direction === 'outgoing' && entry.payload?.method === 'session/prompt') {
        const sessionIdValue = String(entry.payload?.params?.sessionId || entry.payload?.params?.session_id || '');
        if (sessionIdValue) {
          forceNewByKey.set(`${sessionIdValue}:agent`, true);
          forceNewByKey.set(`${sessionIdValue}:system`, true);
        }
        return;
      }
      if (entry.direction !== 'notification') {
        return;
      }
      const payload = entry.payload;
      if (!payload || payload.method !== 'session/update') {
        return;
      }
      const update = payload.params?.update;
      const sessionUpdate = update?.sessionUpdate;
      const sessionIdValue = String(payload.params?.sessionId || payload.params?.session_id || '');
      if (!sessionIdValue || !update?.content) {
        return;
      }
      if (!['agent_message_chunk', 'user_message_chunk', 'agent_thought_chunk'].includes(sessionUpdate)) {
        return;
      }
      const content = formatContentBlock(update.content);
      if (!content) {
        return;
      }
      const role: ChatMessage['role'] = sessionUpdate === 'agent_message_chunk'
        ? 'agent'
        : sessionUpdate === 'user_message_chunk'
        ? 'user'
        : 'system';
      const key = `${sessionIdValue}:${role}`;
      const activeIndex = activeIndexByKey.get(key);
      const forceNew = forceNewByKey.get(key);
      if (activeIndex !== undefined && forceNew !== true) {
        const activeMessage = messages[activeIndex];
        if (activeMessage) {
          activeMessage.content = appendContent(activeMessage.content, content);
          activeMessage.timestamp = entry.timestamp;
          return;
        }
      }
      messages.push({
        id: `${entry.id}-${sessionUpdate}`,
        role,
        content: content.trim(),
        timestamp: entry.timestamp,
        sessionId: sessionIdValue
      });
      activeIndexByKey.set(key, messages.length - 1);
      forceNewByKey.set(key, false);
    });
    return messages;
  }, [logEntries]);

  const resolveWsUrl = (baseUrl: string, token: string) => {
    let urlValue = baseUrl.trim();
    if (!urlValue) {
      return '';
    }
    if (urlValue.startsWith('http://')) {
      urlValue = `ws://${urlValue.slice(7)}`;
    }
    if (urlValue.startsWith('https://')) {
      urlValue = `wss://${urlValue.slice(8)}`;
    }
    try {
      const parsed = new URL(urlValue);
      if (!parsed.pathname || parsed.pathname === '/') {
        parsed.pathname = '/acp';
      }
      if (token.trim()) {
        parsed.searchParams.set('token', token.trim());
      }
      return parsed.toString();
    } catch {
      return urlValue;
    }
  };

  const clearPendingRequests = () => {
    pendingTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    pendingTimeoutsRef.current.clear();
    pendingRequestsRef.current.clear();
    requestTimingsRef.current.clear();
    setPendingPrompts(new Set());
  };

  const connectWs = () => {
    if (connectionStatus === 'connecting' || connectionStatus === 'connected') {
      return;
    }
    const url = resolveWsUrl(apiUrlValue, apiKeyValue);
    if (!url) {
      addLocalLog({ direction: 'error', payload: 'Missing WebSocket URL.' });
      return;
    }
    addLocalLog({ direction: 'notification', payload: `Connecting to ${url}` });
    setConnectionStatus('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      addLocalLog({ direction: 'notification', payload: 'WebSocket connected.' });
    };

    ws.onclose = (event) => {
      setConnectionStatus('disconnected');
      const details = event?.code ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ''})` : '';
      addLocalLog({ direction: 'notification', payload: `WebSocket disconnected${details}.` });
      clearPendingRequests();
      setSessionReady(false);
    };

    ws.onerror = () => {
      setConnectionStatus('error');
      addLocalLog({ direction: 'error', payload: 'WebSocket error.' });
    };

    ws.onmessage = (event) => {
      const handlePayload = (payload: any) => {
        if (!payload || typeof payload !== 'object') {
          addLocalLog({ direction: 'raw', payload: String(payload) });
          return;
        }
        const isNotification = payload.method && (payload.id === undefined || payload.id === null);
        if (isNotification) {
          addLocalLog({ direction: 'notification', payload });
        } else {
          addLocalLog({ direction: 'incoming', payload });
        }
        if (payload.id !== undefined && pendingRequestsRef.current.has(payload.id)) {
          const resolver = pendingRequestsRef.current.get(payload.id);
          if (resolver) {
            resolver(payload);
            pendingRequestsRef.current.delete(payload.id);
          }
          const startedAt = requestTimingsRef.current.get(payload.id);
          if (startedAt) {
            const durationMs = Date.now() - startedAt;
            requestTimingsRef.current.delete(payload.id);
            addLocalLog({ direction: 'notification', payload: `Response ${payload.id} in ${durationMs}ms.` });
          }
        }
        const target = payload?.result?._meta?.target || payload?._meta?.target;
        if (target && (target.url || target.branch || target.revision)) {
          addLocalLog({ direction: 'notification', payload: { message: 'Received _meta.target', target } });
          setRemoteTarget({
            url: target.url || '',
            branch: target.branch || '',
            revision: target.revision || ''
          });
        }
      };

      const parseRaw = async (raw: any) => {
        let text = '';
        if (typeof raw === 'string') {
          text = raw;
        } else if (raw instanceof ArrayBuffer) {
          text = new TextDecoder('utf-8').decode(raw);
        } else if (raw instanceof Blob) {
          text = await raw.text();
        } else {
          text = String(raw);
        }

        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            addLocalLog({ direction: 'notification', payload: `Received batch of ${parsed.length} messages.` });
            parsed.forEach(handlePayload);
          } else {
            handlePayload(parsed);
          }
        } catch {
          addLocalLog({ direction: 'error', payload: 'Failed to parse message as JSON.' });
          addLocalLog({ direction: 'raw', payload: text });
        }
      };

      void parseRaw(event.data);
    };
  };

  const disconnectWs = () => {
    if (wsRef.current) {
      addLocalLog({ direction: 'notification', payload: 'Disconnecting WebSocket...' });
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionStatus('disconnected');
    clearPendingRequests();
  };

  useEffect(() => {
    return () => {
      disconnectWs();
    };
  }, []);

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
    setSessionInitParams(buildSessionRequestTemplate(sessionCommand));
  }, [sessionCommand]);

  useEffect(() => {
    const config = methodConfigs[sessionMethod];
    if (config) {
      try {
        const parsed = JSON.parse(config.template);
        setSessionParams(JSON.stringify(parsed, null, 2));
      } catch {
        setSessionParams(config.template);
      }
    }
  }, [sessionMethod]);

  useEffect(() => {
    if (!sessionId) {
      setSessionReady(false);
      return;
    }
    try {
      const parsed = sessionParams ? JSON.parse(sessionParams) : {};
      if ('sessionId' in parsed) {
        parsed.sessionId = sessionId;
      }
      if ('session_id' in parsed) {
        parsed.session_id = sessionId;
      }
      setSessionParams(JSON.stringify(parsed, null, 2));
    } catch {
      // Ignore invalid JSON updates.
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || sessionCommand !== 'session/load') {
      return;
    }
    try {
      const payload = sessionInitParams ? JSON.parse(sessionInitParams) : {};
      if (payload?.params && typeof payload.params === 'object' && payload.params.sessionId !== sessionId) {
        payload.params.sessionId = sessionId;
        setSessionInitParams(JSON.stringify(payload, null, 2));
      }
    } catch {
      // Ignore invalid JSON updates.
    }
  }, [sessionId, sessionCommand]);

  const updateModelAndModeState = (result: any) => {
    const models = result?.models?.availableModels;
    const currentModelId = result?.models?.currentModelId;
    if (Array.isArray(models)) {
      setAvailableModels(models);
      const qwenModel = models.find((model) =>
        model.modelId.toLowerCase().includes('qwen') || model.name.toLowerCase().includes('qwen')
      );
      if (currentModelId) {
        setSelectedModelId(currentModelId);
      } else if (qwenModel) {
        setSelectedModelId(qwenModel.modelId);
      } else if (models.length > 0) {
        setSelectedModelId(models[0].modelId);
      }

      if (sessionId && sessionReady && qwenModel && currentModelId && currentModelId !== qwenModel.modelId) {
        if (autoModelSessionRef.current !== sessionId) {
          autoModelSessionRef.current = sessionId;
          setSelectedModelId(qwenModel.modelId);
          void sendAcpRequest('session/set_model', {
            sessionId,
            modelId: qwenModel.modelId
          });
        }
      }
    }

    const modes = result?.modes?.availableModes;
    const currentModeId = result?.modes?.currentModeId;
    if (Array.isArray(modes)) {
      setAvailableModes(modes);
      if (currentModeId) {
        setSelectedModeId(currentModeId);
      } else if (modes.length > 0) {
        setSelectedModeId(modes[0].id);
      }
    }
  };

  const sendWsRequest = (payload: any, requestIdValue: number | string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addLocalLog({ direction: 'error', payload: 'Connect to the WebSocket server first.' });
      return null;
    }
    ws.send(JSON.stringify(payload));
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pendingRequestsRef.current.delete(requestIdValue);
        pendingTimeoutsRef.current.delete(requestIdValue);
        requestTimingsRef.current.delete(requestIdValue);
        addLocalLog({ direction: 'error', payload: `Request ${requestIdValue} timed out.` });
        resolve({ error: { message: 'Response timeout' } });
      }, REQUEST_TIMEOUT_MS);
      pendingTimeoutsRef.current.set(requestIdValue, timeoutId);
      pendingRequestsRef.current.set(requestIdValue, (data) => {
        window.clearTimeout(timeoutId);
        pendingTimeoutsRef.current.delete(requestIdValue);
        resolve(data);
      });
    });
  };

  const applyRemoteMeta = (paramsPayload: any) => {
    if (!remoteMetaEnabled) {
      return paramsPayload;
    }
    const url = remoteGitInfo.url.trim();
    const branch = remoteGitInfo.branch.trim();
    const revision = remoteGitInfo.revision.trim();
    if (!url || !branch || !revision) {
      addLocalLog({ direction: 'error', payload: 'Fill url, branch, and revision before starting a remote session.' });
      return null;
    }
    const nextPayload = { ...paramsPayload };
    nextPayload._meta = { ...(paramsPayload?._meta || {}) };
    nextPayload._meta.remote = { url, branch, revision };
    addLocalLog({ direction: 'notification', payload: { message: 'Applied _meta.remote', remote: nextPayload._meta.remote } });
    return nextPayload;
  };

  const sendAcpRequest = async (method: string, paramsPayload: any) => {
    setLoading(true);
    const requestIdValue = requestId;
    const payload = {
      jsonrpc: '2.0',
      id: requestIdValue,
      method,
      params: paramsPayload
    };
    setRequestId((prev) => prev + 1);
    requestTimingsRef.current.set(requestIdValue, Date.now());
    addLocalLog({ direction: 'outgoing', payload });
    if (method === 'session/prompt') {
      setPendingPrompts((prev) => new Set(prev).add(requestIdValue));
    }

    try {
      const response = await sendWsRequest(payload, requestIdValue);
      if (!response) {
        requestTimingsRef.current.delete(requestIdValue);
        return null;
      }
      if (method === 'session/prompt') {
        setPendingPrompts((prev) => {
          const next = new Set(prev);
          next.delete(requestIdValue);
          return next;
        });
      }
      if (method === 'session/new' || method === 'session/load') {
        const sessionFromResult = response.result?.session_id || response.result?.sessionId || response.session_id || response.sessionId;
        const sessionFromParams = paramsPayload.sessionId || paramsPayload.session_id;
        const sessionResolved = sessionFromResult || sessionFromParams;
        if (sessionResolved) {
          setSessionId(sessionResolved);
          setSessionReady(true);
        }
      }
      if (response.result) {
        updateModelAndModeState(response.result);
      }
      if (response.error) {
        addLocalLog({ direction: 'error', payload: response.error });
      }
      return response;
    } catch (err) {
      addLocalLog({
        direction: 'error',
        payload: err instanceof Error ? err.message : 'Unknown ACP error'
      });
      requestTimingsRef.current.delete(requestIdValue);
      if (method === 'session/prompt') {
        setPendingPrompts((prev) => {
          const next = new Set(prev);
          next.delete(requestIdValue);
          return next;
        });
      }
      return null;
    } finally {
      setLoading(false);
    }
  };

  const sendAcpNotification = async (method: string, paramsPayload: any) => {
    setLoading(true);
    const payload = {
      jsonrpc: '2.0',
      method,
      params: paramsPayload
    };
    addLocalLog({ direction: 'outgoing', payload });

    try {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLocalLog({ direction: 'error', payload: 'Connect to the WebSocket server first.' });
        return;
      }
      ws.send(JSON.stringify(payload));
    } catch (err) {
      addLocalLog({
        direction: 'error',
        payload: err instanceof Error ? err.message : 'Unknown ACP error'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleModeChange = (modeId: string) => {
    setSelectedModeId(modeId);
    if (!sessionReady) {
      addLocalLog({ direction: 'error', payload: 'Start a session before switching modes.' });
      return;
    }
    void sendAcpRequest('session/set_mode', {
      sessionId,
      modeId
    });
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModelId(modelId);
    if (!sessionReady) {
      addLocalLog({ direction: 'error', payload: 'Start a session before switching models.' });
      return;
    }
    void sendAcpRequest('session/set_model', {
      sessionId,
      modelId
    });
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

  const handleSessionCommand = () => {
    try {
      const parsed = sessionInitParams ? JSON.parse(sessionInitParams) : {};
      const methodValue = typeof parsed.method === 'string' ? parsed.method : sessionCommand;
      const paramsPayload = parsed.params && typeof parsed.params === 'object' ? parsed.params : parsed;
      if (methodValue === 'session/new') {
        const nextPayload = applyRemoteMeta(paramsPayload);
        if (!nextPayload) {
          return;
        }
        void sendAcpRequest(methodValue, nextPayload);
        return;
      }
      void sendAcpRequest(methodValue, paramsPayload);
    } catch (err) {
      addLocalLog({
        direction: 'error',
        payload: `Invalid JSON in session params: ${err instanceof Error ? err.message : 'Unknown error'}`
      });
    }
  };

  const statusLabel = connectionStatus === 'connected'
    ? 'Connected'
    : connectionStatus === 'connecting'
    ? 'Connecting'
    : connectionStatus === 'error'
    ? 'Error'
    : 'Disconnected';
  const statusDot = connectionStatus === 'connected'
    ? 'bg-green-500'
    : connectionStatus === 'connecting'
    ? 'bg-amber-500'
    : connectionStatus === 'error'
    ? 'bg-red-500'
    : 'bg-gray-400';

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-800 mb-6">ACP Remote Run Tester</h1>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">WebSocket URL</label>
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
                placeholder="ws://localhost:3001/acp"
              />
            )}
            <p className="text-xs text-gray-500 mt-2">
              URL changes take effect after reconnect.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Client Token (Optional)</label>
            <input
              type="password"
              value={apiKeyValue}
              onChange={(e) => setApiKeyValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Token appended as ?token= for browser WebSocket"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
            connectionStatus === 'connected'
              ? 'bg-green-100 text-green-800'
              : connectionStatus === 'error'
              ? 'bg-red-100 text-red-700'
              : 'bg-gray-100 text-gray-600'
          }`}>
            <span className={`w-2 h-2 rounded-full mr-2 ${statusDot}`}></span>
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={() => {
              if (connectionStatus === 'connected') {
                disconnectWs();
              } else {
                connectWs();
              }
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {connectionStatus === 'connected' ? 'Disconnect' : 'Connect'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-2">Remote Run Metadata</h2>
        <p className="text-sm text-gray-500 mb-4">
          Add git details from the IDE so the remote agent can clone and push to a target branch.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Repository URL</label>
            <input
              type="text"
              value={remoteGitInfo.url}
              onChange={(e) => setRemoteGitInfo((prev) => ({ ...prev, url: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs"
              placeholder="git@github.com:user/repo.git"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Remote Branch</label>
            <input
              type="text"
              value={remoteGitInfo.branch}
              onChange={(e) => setRemoteGitInfo((prev) => ({ ...prev, branch: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs"
              placeholder="main"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Revision</label>
            <input
              type="text"
              value={remoteGitInfo.revision}
              onChange={(e) => setRemoteGitInfo((prev) => ({ ...prev, revision: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs"
              placeholder="abc123def456"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={remoteMetaEnabled}
            onChange={(e) => setRemoteMetaEnabled(e.target.checked)}
          />
          <span>Include _meta.remote in session/new requests</span>
        </div>
        {remoteTarget && (
          <div className="mt-4 border border-emerald-200 bg-emerald-50 rounded-md p-3 text-xs text-emerald-700">
            <div className="font-semibold mb-1">Latest target branch</div>
            <div>URL: {remoteTarget.url || 'n/a'}</div>
            <div>Branch: {remoteTarget.branch || 'n/a'}</div>
            <div>Revision: {remoteTarget.revision || 'n/a'}</div>
          </div>
        )}
      </div>

      <details className="bg-white rounded-lg shadow-md p-6 mb-6">
        <summary className="text-xl font-semibold text-gray-700 cursor-pointer">Commands</summary>
        <form onSubmit={handleSubmit} className="mt-4">
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">ACP Method</label>
            <div className="flex items-center space-x-2">
              <PrettySelect
                value={selectedMethod}
                onChange={setSelectedMethod}
                options={endpointMethods.map((method) => ({ value: method.value, label: method.label }))}
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
              {methodConfigs[selectedMethod]?.description ? (
                <div dangerouslySetInnerHTML={{ __html: methodConfigs[selectedMethod].description }} />
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
              placeholder='{"methodId":"..."}'
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
      </details>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-700 mb-4">Create Session</h2>
        <p className="text-sm text-gray-500 mt-1">
          Create a new remote session or load an existing one. The returned session ID will be filled automatically.
        </p>
        <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Session Command</label>
        <PrettySelect
          value={sessionCommand}
          onChange={(value) => setSessionCommand(value as 'session/new' | 'session/load')}
          options={[
            { value: 'session/new', label: 'session/new' },
            { value: 'session/load', label: 'session/load' }
          ]}
          className="w-full"
        />
        <div className="mt-3 bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-md text-xs">
          {methodConfigs[sessionCommand]?.description ? (
            <div dangerouslySetInnerHTML={{ __html: methodConfigs[sessionCommand].description }} />
          ) : (
            'No description available for this method.'
          )}
        </div>
        <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Session Request (JSON-RPC)</label>
        <textarea
          value={sessionInitParams}
          onChange={(e) => setSessionInitParams(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-40 text-xs"
          placeholder='{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}'
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSessionCommand}
            disabled={loading}
            className={`inline-flex items-center px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
              loading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            Run Session Command
          </button>
          <button
            type="button"
            onClick={() => {
              setSessionId('');
              setSessionReady(false);
              addLocalLog({ direction: 'notification', payload: 'Session cleared locally.' });
            }}
            className="inline-flex items-center px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
          >
            End Session
          </button>
        </div>
        {sessionId && (
          <p className="mt-3 text-xs text-gray-500">Active session: {sessionId}</p>
        )}
        {(availableModels.length > 0 || availableModes.length > 0) && (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {availableModels.length > 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-700">Model</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Switch the active model for the current session.
                </p>
                <div className="mt-3">
                  <PrettySelect
                    value={selectedModelId}
                    onChange={handleModelChange}
                    options={availableModels.map((model) => ({
                      value: model.modelId,
                      label: `${model.name} (${model.modelId})`
                    }))}
                    className="w-full"
                  />
                </div>
                {selectedModelId && (
                  <div className="mt-2 text-xs text-gray-600">
                    {availableModels.find((model) => model.modelId === selectedModelId)?.description}
                  </div>
                )}
              </div>
            )}
            {availableModes.length > 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-700">Mode</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Choose a mode to apply with <span className="font-semibold">session/set_mode</span>.
                </p>
                <div className="mt-3">
                  <PrettySelect
                    value={selectedModeId}
                    onChange={handleModeChange}
                    options={availableModes.map((mode) => ({
                      value: mode.id,
                      label: `${mode.name} (${mode.id})`
                    }))}
                    className="w-full"
                  />
                </div>
                {selectedModeId && (
                  <div className="mt-2 text-xs text-gray-600">
                    {availableModes.find((mode) => mode.id === selectedModeId)?.description}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`bg-white rounded-lg shadow-md p-6 mb-6 ${sessionReady ? '' : 'opacity-60'}`}>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Session Communication</h2>
            <p className="text-sm text-gray-500 mt-1">
              Send prompts or cancel in-flight requests for the active session.
            </p>
          </div>
          <div className="text-xs text-gray-500">
            {sessionReady ? 'Session ready' : 'Awaiting session init'}
          </div>
        </div>
        <div className="mt-4 border border-gray-200 rounded-lg p-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">Session Method</label>
          <PrettySelect
            value={sessionMethod}
            onChange={(value) => setSessionMethod(value as 'session/prompt' | 'session/cancel' | 'session/set_mode')}
            options={sessionMethods.map((method) => ({ value: method.value, label: method.label }))}
            className="w-full"
          />
          <div className="mt-3 bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-md text-xs">
            {methodConfigs[sessionMethod]?.description ? (
              <div dangerouslySetInnerHTML={{ __html: methodConfigs[sessionMethod].description }} />
            ) : (
              'No description available for this method.'
            )}
          </div>
          <label className="block text-xs font-medium text-gray-600 mt-4 mb-1">Session Parameters (JSON)</label>
          <textarea
            value={sessionParams}
            onChange={(e) => setSessionParams(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 h-40 text-xs"
            placeholder='{"sessionId":"sess_abc123","prompt":[{"type":"text","text":"Hello"}]}'
            disabled={!sessionReady}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (!sessionReady) {
                  addLocalLog({ direction: 'error', payload: 'Run session/new or session/load first.' });
                  return;
                }
                try {
                  const parsed = sessionParams ? JSON.parse(sessionParams) : {};
                  if (sessionMethod === 'session/cancel') {
                    void sendAcpNotification(sessionMethod, parsed);
                  } else {
                    void sendAcpRequest(sessionMethod, parsed);
                  }
                } catch (err) {
                  addLocalLog({
                    direction: 'error',
                    payload: `Invalid JSON in session params: ${err instanceof Error ? err.message : 'Unknown error'}`
                  });
                }
              }}
              disabled={loading || !sessionReady}
              className={`inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                loading || !sessionReady ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Send Session Request
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Session Updates</h2>
            <p className="text-sm text-gray-500 mt-1">
              Live chat view of <span className="font-mono">session/update</span> notifications.
            </p>
          </div>
          {sessionId && (
            <span className="text-xs text-gray-500">Session: {sessionId}</span>
          )}
        </div>
        {pendingPrompts.size > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <span className="inline-flex h-2 w-2 rounded-full bg-blue-500 animate-pulse"></span>
            Agent is responding...
          </div>
        )}
        <div className="mt-4 border border-gray-200 rounded-md max-h-80 overflow-auto bg-slate-50 p-4 space-y-3">
          {chatMessages.length === 0 ? (
            <div className="text-sm text-gray-500">No session updates yet.</div>
          ) : (
            chatMessages
              .filter((message) => !sessionId || message.sessionId === sessionId)
              .map((message) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow ${
                    message.role === 'agent'
                      ? 'bg-white border border-slate-200 text-slate-700'
                      : message.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-200 text-slate-700'
                  }`}>
                    <div className="whitespace-pre-wrap">{message.content}</div>
                    <div className={`mt-2 text-[10px] ${
                      message.role === 'agent'
                        ? 'text-slate-400'
                        : message.role === 'user'
                        ? 'text-blue-100'
                        : 'text-slate-500'
                    }`}>
                      {new Date(message.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-700">Live Log</h2>
            <p className="text-sm text-gray-500 mt-1">
              WebSocket request/response log for ACP remote sessions.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setLogEntries([])}
              className="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              Clear
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

export default ACPRemoteTester;
