#!/usr/bin/env node

const { NodeSSH } = require('node-ssh');
const path = require('path');
const rlSync = require('readline-sync');
const { execSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const remote = args.find(a => !a.startsWith('--'));
const skipPassword = args.includes('--no-password');
const nodePathArg = args.find(a => a.startsWith('--node='));
const customNodePath = nodePathArg ? nodePathArg.split('=')[1] : null;

if (!remote) {
  console.error('Usage: node deploy.js <user@host> [--no-password] [--node=/path/to/node]');
  console.error('');
  console.error('Options:');
  console.error('  --no-password    Use SSH key authentication instead of password');
  console.error('  --node=/path     Specify the path to node on the remote machine');
  process.exit(1);
}

const BUNDLE_OUTPUT = path.join(__dirname, 'packages/server-remote-acp/dist-bundle/remote-run.bundle.js');

async function main() {
  console.log('Building server-remote-acp...');
  
  // First, run TypeScript build to compile the source files
  try {
    execSync('npm run build:server', { stdio: 'inherit', cwd: __dirname });
  } catch (err) {
    console.error('TypeScript build failed');
    process.exit(1);
  }

  console.log('Bundling with esbuild...');
  
  // Create output directory for the bundle
  const bundleDir = path.dirname(BUNDLE_OUTPUT);
  if (!fs.existsSync(bundleDir)) {
    fs.mkdirSync(bundleDir, { recursive: true });
  }

  // Use esbuild to bundle everything into a single file
  // This will include all dependencies (ws, etc.) in one self-contained file
  try {
    execSync([
      'npx esbuild',
      path.join(__dirname, 'packages/server-remote-acp/dist/remote-run.js'),
      '--bundle',
      '--platform=node',
      '--target=node18',
      `--outfile=${BUNDLE_OUTPUT}`,
      '--format=cjs',
      // Mark optional native modules as external (ws has optional perf deps)
      '--external:bufferutil',
      '--external:utf-8-validate',
    ].join(' '), { stdio: 'inherit', cwd: __dirname });
  } catch (err) {
    console.error('Bundling failed');
    process.exit(1);
  }

  console.log(`Bundle created: ${BUNDLE_OUTPUT}`);
  const bundleStats = fs.statSync(BUNDLE_OUTPUT);
  console.log(`Bundle size: ${(bundleStats.size / 1024).toFixed(1)} KB`);

  const ssh = new NodeSSH();
  
  let password = null;
  
  if (!skipPassword) {
    password = rlSync.question(`Enter password for ${remote}: `, { hideEchoBack: true });
    console.log();
  }
  
  await connectAndDeploy(ssh, password);
  
  async function connectAndDeploy(sshClient, password) {
    console.log('Connecting to remote...');
    
    const connectOptions = {
      host: remote.split('@')[1] || remote,
      username: remote.split('@')[0],
    };
    
    if (password) {
      connectOptions.password = password;
    }
    
    try {
      await sshClient.connect(connectOptions);
      console.log('Connected successfully');
    } catch (err) {
      console.error('Connection failed:', err.message);
      process.exit(1);
    }
    
    try {
      // Get the actual home directory path on remote
      const homeResult = await sshClient.execCommand('echo $HOME');
      const remoteHome = homeResult.stdout.trim();
      const remoteDir = `${remoteHome}/scripts/acp-remote`;
      
      console.log(`Remote directory: ${remoteDir}`);
      
      console.log('Creating remote directory structure...');
      await sshClient.execCommand(`mkdir -p ${remoteDir}`);
      
      console.log('Stopping any existing server...');
      await sshClient.execCommand('pkill -f "node.*remote-run.bundle.js" || true');
      
      console.log('Copying bundled file to remote...');
      await sshClient.putFile(BUNDLE_OUTPUT, `${remoteDir}/remote-run.bundle.js`);

      console.log('Finding node on remote...');
      
      let nodeBin = customNodePath;
      
      if (!nodeBin) {
        // Check common node locations directly by testing each path
        const nodePaths = [
          '/opt/homebrew/bin/node',        // macOS with Homebrew (Apple Silicon)
          '/usr/local/bin/node',           // macOS with Homebrew (Intel) / manual install
          '/usr/bin/node',                 // Linux system install
          '$HOME/.nvm/versions/node/*/bin/node',  // nvm
          '$HOME/.local/bin/node',         // user local install
          '$HOME/.volta/bin/node',         // volta
          '$HOME/.asdf/shims/node',        // asdf
          '/opt/local/bin/node',           // MacPorts
        ];
        
        // Test each path directly
        for (const nodePath of nodePaths) {
          const checkResult = await sshClient.execCommand(
            `for p in ${nodePath}; do if [ -x "$p" ]; then echo "$p"; exit 0; fi; done`
          );
          const found = checkResult.stdout.trim();
          if (found) {
            nodeBin = found;
            break;
          }
        }
      }
      
      if (!nodeBin) {
        console.error('Error: Node.js not found on remote machine.');
        console.error('Checked locations:');
        console.error('  - /opt/homebrew/bin/node (macOS Homebrew Apple Silicon)');
        console.error('  - /usr/local/bin/node (macOS Homebrew Intel / manual)');
        console.error('  - /usr/bin/node (Linux system)');
        console.error('  - ~/.nvm/versions/node/*/bin/node (nvm)');
        console.error('  - ~/.volta/bin/node (volta)');
        console.error('  - ~/.asdf/shims/node (asdf)');
        console.error('\nPlease specify the node path manually: node deploy.js user@host --node=/path/to/node');
        sshClient.dispose();
        process.exit(1);
      }
      
      // Verify node works and get version
      const verifyResult = await sshClient.execCommand(`"${nodeBin}" --version`);
      if (verifyResult.code !== 0) {
        console.error(`Error: Node not executable at: ${nodeBin}`);
        console.error(verifyResult.stderr);
        sshClient.dispose();
        process.exit(1);
      }
      
      console.log(`Using node: ${nodeBin} (${verifyResult.stdout.trim()})`);
      
      console.log('Starting server on remote...');
      const startResult = await sshClient.execCommand(
        `cd ${remoteDir} && ` +
        `nohup "${nodeBin}" "${remoteDir}/remote-run.bundle.js" > "${remoteDir}/server.log" 2>&1 & ` +
        'echo $!'
      );
      
      const pid = startResult.stdout.trim();
      if (pid) {
        console.log(`Server started with PID: ${pid}`);
      }
      
      console.log('Waiting for server to start...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get a remote host for health check from a local machine
      const remoteHost = remote.split('@')[1] || remote;
      
      console.log(`Checking server status from local machine (http://${remoteHost}:3011/health)...`);
      try {
        const healthCheck = execSync(`curl -s --connect-timeout 5 http://${remoteHost}:3011/health`, { encoding: 'utf8' });
        console.log(healthCheck.trim());
      } catch (err) {
        console.log('Server not responding from local machine');
        
        // Check if it's running on the remote at least
        console.log('\nChecking if server is running on remote...');
        const remoteCheck = await sshClient.execCommand('curl -s http://localhost:3011/health');
        if (remoteCheck.stdout.includes('ok')) {
          console.log('Server IS running on remote (localhost:3011 responds)');
          console.log('But it is NOT reachable from your local machine.');
          console.log('Possible causes:');
          console.log('  - Firewall blocking port 3011');
          console.log('  - Server bound to localhost only');
          console.log('  - Network/routing issue');
        } else {
          console.log('Server is not running on remote either.');
          console.log('\nServer log (last 20 lines):');
          const logResult = await sshClient.execCommand(`tail -20 ${remoteDir}/server.log 2>/dev/null || echo "No log file"`);
          console.log(logResult.stdout || logResult.stderr);
        }
      }
      
      console.log('\nDeployment complete!');
      console.log('Server is running on remote machine.');
      console.log(`Logs are available at: ${remoteDir}/server.log`);
      
      sshClient.dispose();
    } catch (err) {
      console.error('Deployment failed:', err.message);
      sshClient.dispose();
      process.exit(1);
    }
  }
}

main();
