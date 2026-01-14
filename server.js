// proxy.js
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const TARGET = "http://localhost:1234";

/**
 * Disable CORS restrictions
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // Handle preflight requests directly
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/**
 * Proxy everything
 */
app.use(
    "/",
    createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
      ws: true,
      xfwd: true,
      proxyTimeout: 60_000,
      timeout: 60_000,
      logLevel: "warn",

      // Ensure proxied responses also include CORS headers
      onProxyRes(proxyRes) {
        proxyRes.headers["access-control-allow-origin"] = "*";
        proxyRes.headers["access-control-allow-methods"] = "*";
        proxyRes.headers["access-control-allow-headers"] = "*";
        proxyRes.headers["access-control-allow-credentials"] = "true";
      },
    })
);

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Proxy running on http://localhost:${port} -> ${TARGET}`);
});
