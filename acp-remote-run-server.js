const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "packages", "server-remote-acp", "dist", "remote-run.js");

if (!fs.existsSync(entry)) {
  console.error("ACP remote-run server build not found.");
  console.error("Run: npm run --prefix packages/server-remote-acp build");
  process.exit(1);
}

require(entry);

