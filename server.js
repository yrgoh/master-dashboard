import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 4000;

// Ensure logs directory exists
const logsDir = join(__dirname, 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

// Load apps config
const configPath = join(__dirname, 'apps-config.json');
let appsConfig = [];
try {
  const raw = readFileSync(configPath, 'utf-8');
  appsConfig = JSON.parse(raw);
} catch (err) {
  console.error('Failed to load apps-config.json:', err.message);
  process.exit(1);
}

// ─── Process Management ─────────────────────────────────────────────────────

const runningProcesses = new Map();

function killPort(port) {
  if (!port) return;
  try {
    // Find PID listening on the port, then kill it
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8', timeout: 5000 });
    const lines = out.trim().split('\n');
    const pids = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
    for (const pid of pids) {
      console.log(`[${timestamp()}] Killing PID ${pid} on port ${port}`);
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'ignore' });
    }
  } catch { /* port is free or command failed */ }
}

function getStatus(appId) {
  if (!runningProcesses.has(appId)) return 'stopped';
  const procs = runningProcesses.get(appId);
  const be = procs.backend;
  const fe = procs.frontend;
  const beAlive = be && be.exitCode === null && !be._killed;
  const feAlive = fe && fe.exitCode === null && !fe._killed;

  // If any process reported an error at startup
  if (procs._error) return 'error';

  // Still in the initial startup window
  if (procs._startTime && Date.now() - procs._startTime < 3000) {
    return (beAlive || feAlive || (!be && !fe)) ? 'starting' : 'error';
  }

  return (beAlive || feAlive) ? 'running' : (procs._crashed ? 'error' : 'stopped');
}

function getLogStream(appId, type) {
  const logPath = join(logsDir, `${appId}-${type}.log`);
  return createWriteStream(logPath, { flags: 'a' });
}

function timestamp() {
  return new Date().toISOString();
}

function spawnProcess(appId, type, cmdObj, appPath) {
  const { cmd, args, env: extraEnv } = cmdObj;
  console.log(`[${timestamp()}] Starting ${appId} ${type}: ${cmd} ${(args || []).join(' ')}`);

  const child = spawn(cmd, args || [], {
    cwd: appPath || process.cwd(),
    shell: true,
    env: { ...process.env, ...(extraEnv || {}) },
    stdio: 'pipe',
  });

  child._killed = false;
  const logStream = getLogStream(appId, type);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on('exit', (code) => {
    console.log(`[${timestamp()}] ${appId} ${type} exited with code ${code}`);
    const procs = runningProcesses.get(appId);
    if (code !== 0 && procs) procs._crashed = true;
  });

  child.on('error', (err) => {
    console.error(`[${timestamp()}] ${appId} ${type} spawn error:`, err.message);
    const procs = runningProcesses.get(appId);
    if (procs) procs._error = true;
  });

  return child;
}

async function startApp(appId) {
  const appCfg = appsConfig.find(a => a.id === appId);
  if (!appCfg) throw new Error(`App "${appId}" not found in config`);

  const existing = runningProcesses.get(appId);
  if (existing) {
    const be = existing.backend;
    const fe = existing.frontend;
    const alive = (be && be.exitCode === null && !be._killed) || (fe && fe.exitCode === null && !fe._killed);
    if (alive) throw new Error(`App "${appId}" is already running`);
    runningProcesses.delete(appId);
  }

  const procs = { backend: null, frontend: null, _startTime: Date.now(), _error: false, _crashed: false };
  runningProcesses.set(appId, procs);

  // Free ports before launching so orphaned servers don't block us
  killPort(appCfg.backendPort);
  killPort(appCfg.frontendPort);

  // Start backend first if configured
  if (appCfg.commands.backend) {
    procs.backend = spawnProcess(appId, 'backend', appCfg.commands.backend, appCfg.path);
  }

  // Start frontend — delay slightly if backend also started
  if (appCfg.commands.frontend) {
    const delay = appCfg.commands.backend ? 1500 : 0;
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    procs.frontend = spawnProcess(appId, 'frontend', appCfg.commands.frontend, appCfg.path);
  }

  return { ok: true, status: 'starting' };
}

function stopApp(appId) {
  const procs = runningProcesses.get(appId);
  if (!procs) throw new Error(`App "${appId}" is not running`);

  console.log(`[${timestamp()}] Stopping ${appId}...`);

  for (const type of ['frontend', 'backend']) {
    const child = procs[type];
    if (child && child.exitCode === null && !child._killed) {
      child._killed = true;
      const pid = child.pid;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { shell: true, stdio: 'ignore' });
        } else {
          process.kill(-pid, 'SIGTERM');
        }
      } catch (e) { /* already dead */ }
    }
  }

  runningProcesses.delete(appId);
  return { ok: true, status: 'stopped' };
}

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/apps', (_req, res) => {
  const result = appsConfig.map(cfg => ({
    id: cfg.id,
    name: cfg.name,
    description: cfg.description,
    techStack: cfg.techStack,
    icon: cfg.icon,
    frontendUrl: cfg.frontendUrl,
    backendUrl: cfg.backendUrl,
    frontendPort: cfg.frontendPort,
    backendPort: cfg.backendPort,
    status: getStatus(cfg.id),
  }));
  res.json(result);
});

app.post('/api/apps/:id/start', async (req, res) => {
  try {
    const result = await startApp(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/apps/:id/stop', (req, res) => {
  try {
    const result = stopApp(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[master-dashboard] Running on http://localhost:${PORT}`);
  console.log(`[master-dashboard] ${appsConfig.length} apps configured`);
  for (const a of appsConfig) {
    console.log(`  - ${a.name} (${a.id}) → ${a.frontendUrl || 'no frontend'}`);
  }
});
