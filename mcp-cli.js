const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "packages", "server-main", "dist", "mcp-cli.js");

if (!fs.existsSync(entry)) {
  console.error("MCP CLI build not found.");
  console.error("Run: npm run --prefix packages/server-main build");
  process.exit(1);
}

require(entry);

