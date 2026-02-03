import { ACP_REMOTE_LOG_PAYLOADS } from "./config";

export const normalizePath = (value: string) => {
  if (!value) {
    return "/";
  }
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
};

export const getRequestUrl = (req: any) => new URL(req.url, `http://${req.headers.host || "localhost"}`);

export const redactUrlForLogs = (url: any) => {
  if (!url) {
    return "";
  }
  try {
    const copy = new URL(url.toString());
    for (const key of ["token", "authorization", "api_key", "apikey"]) {
      if (copy.searchParams.has(key)) {
        copy.searchParams.set(key, "[REDACTED]");
      }
    }
    return `${copy.pathname}${copy.search || ""}`;
  } catch {
    return String(url);
  }
};

export const closeSocket = (socket: any, status: any, message?: any) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n${message || ""}`);
  socket.destroy();
};

export const isAuthorized = (token: string, authHeader: any, queryToken: any) => {
  if (!token) {
    return true;
  }
  if (authHeader === token || authHeader === `Bearer ${token}`) {
    return true;
  }
  return queryToken === token;
};

export const buildJsonRpcError = (id: any, message: string, code = -32600) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message }
});

export const parseJson = (data: any) => {
  const raw = typeof data === "string" ? data : data.toString("utf8");
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    return { value: null, raw };
  }
};

export const isJsonRpcRequest = (payload: any) => payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.method === "string";

export const normalizeJsonRpcError = (error: any) => {
  if (error && typeof error === "object") {
    const code = typeof error.code === "number" ? error.code : -32000;
    const message = typeof error.message === "string" ? error.message : "Unknown error";
    return { ...error, code, message };
  }
  if (typeof error === "string") {
    return { code: -32000, message: error };
  }
  return { code: -32000, message: "Unknown error" };
};

export const normalizeJsonRpcNotification = (payload: any) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (typeof payload.method !== "string") {
    return null;
  }
  const normalized: any = { ...payload, jsonrpc: payload.jsonrpc || "2.0" };
  if ("id" in normalized && (normalized.id === undefined || normalized.id === null)) {
    delete normalized.id;
  }
  return normalized;
};

export const normalizeJsonRpcResponse = (response: any, id: any) => {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    if ("result" in response || "error" in response) {
      const normalized: any = { ...response };
      normalized.jsonrpc = normalized.jsonrpc || "2.0";
      normalized.id = id;
      if ("error" in normalized) {
        normalized.error = normalizeJsonRpcError(normalized.error);
      }
      return normalized;
    }
    if (response.error && typeof response.error === "object") {
      return { jsonrpc: "2.0", id, error: normalizeJsonRpcError(response.error) };
    }
  }
  return { jsonrpc: "2.0", id, result: response ?? null };
};

export const describeMessage = (payload: any) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { type: Array.isArray(payload) ? "batch" : typeof payload };
  }
  const hasMethod = typeof payload.method === "string";
  const hasId = payload.id !== undefined;
  const hasResult = "result" in payload;
  const hasError = "error" in payload;
  const type = hasMethod
    ? (hasId ? "request" : "notification")
    : (hasId && (hasResult || hasError) ? "response" : "unknown");
  return {
    type,
    jsonrpc: payload.jsonrpc,
    method: hasMethod ? payload.method : undefined,
    id: hasId ? payload.id : undefined,
    hasResult,
    hasError
  };
};

export const safeStringify = (payload: any, maxLength = 2_000) => {
  if (!ACP_REMOTE_LOG_PAYLOADS) {
    return "";
  }
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(payload, (key, value) => {
      if (typeof key === "string") {
        const lowered = key.toLowerCase();
        if (lowered.includes("token") || lowered.includes("authorization") || lowered.includes("api_key") || lowered.includes("apikey")) {
          return "[REDACTED]";
        }
      }
      if (typeof value === "string" && value.length > 500) {
        return `${value.slice(0, 500)}…(${value.length - 500} more chars)`;
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });
    if (json.length <= maxLength) {
      return json;
    }
    return `${json.slice(0, maxLength)}…(${json.length - maxLength} more chars)`;
  } catch (err) {
    return `<<unserializable:${err instanceof Error ? err.message : String(err)}>>`;
  }
};

export const getSessionIdFromParams = (params: any) => {
  if (!params || typeof params !== "object") {
    return "";
  }
  const direct: any = (params as any).sessionId || (params as any).session_id;
  return direct ? String(direct) : "";
};

export const getSessionIdFromResult = (result: any) => {
  if (!result || typeof result !== "object") {
    return "";
  }
  const direct: any = (result as any).sessionId || (result as any).session_id;
  return direct ? String(direct) : "";
};

export const stripMetaFromParams = (params: any) => {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  if (!("_meta" in params)) {
    return params;
  }
  const copy: any = { ...params };
  delete copy._meta;
  return copy;
};

