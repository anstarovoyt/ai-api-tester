// proxy.js
import express from "express";
import {createProxyMiddleware} from "http-proxy-middleware";

const forwarded_to_port = "64342"
// const port = "1234"

const app = express();
const TARGET = `http://localhost:${forwarded_to_port}`;

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
        pathRewrite: (path) => path,
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

const serve_port = process.env.PORT || 3001;
app.listen(serve_port, () => {
    console.log(`Proxy running on http://localhost:${serve_port} -> ${TARGET}`);
});
