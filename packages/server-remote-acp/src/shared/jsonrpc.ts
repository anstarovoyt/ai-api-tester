export const normalizePath = (value: string) => {
  if (!value) {
    return "/";
  }
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
};

export const getRequestUrl = (req: any) => new URL(req.url, `http://${req?.headers?.host || "localhost"}`);

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

