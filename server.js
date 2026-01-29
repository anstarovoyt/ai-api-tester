const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "packages", "server-main", "dist", "index.js");

if (!fs.existsSync(entry)) {
  console.error("Server build not found.");
  console.error("Run: npm run build:server");
  process.exit(1);
}

require(entry);

