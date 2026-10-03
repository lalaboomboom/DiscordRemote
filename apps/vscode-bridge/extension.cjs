const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function activate(context) {
  const configured = vscode.workspace.getConfiguration('remoteOperator').get('bridgeDirectory');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const fallback = path.join(os.homedir(), '.remote-operator', 'agent');
  function discoverRoot() {
    if (configured) return configured;
    if (process.env.REMOTE_OPERATOR_AGENT_STATE) return path.resolve(process.env.REMOTE_OPERATOR_AGENT_STATE);
    const locator = path.join(os.homedir(), '.remote-operator', 'vscode-bridge.json');
    try {
      if (fs.statSync(locator).size <= 8192) {
        const doc = JSON.parse(fs.readFileSync(locator, 'utf8'));
        if (doc.version === 1 && typeof doc.bridgeDirectory === 'string' && path.isAbsolute(doc.bridgeDirectory)) return doc.bridgeDirectory;
      }
    } catch {}
    if (!vscode.env.remoteName && folder) {
      const agent = path.join(folder, '.remote-operator', 'agent');
      if (fs.existsSync(path.join(agent, 'enrollment.json'))) return agent;
      const bridge = path.join(folder, '.discord-bridge');
      if (fs.existsSync(bridge)) return bridge;
    }
    const legacy = path.join(os.homedir(), 'Documents', 'MCP', '.discord-bridge');
    return fs.existsSync(legacy) ? legacy : fallback;
  }
  const root = discoverRoot();
  if (!root || !path.isAbsolute(root)) return;
  const dir = path.join(root, 'vscode');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const instance = crypto.randomBytes(8).toString('hex');
  const metadata = path.join(dir, `instance-${instance}.json`);
  const shared = new Map();
  const records = new Map();
  let busy = false;
  let disposed = false;
  const machine = vscode.env.remoteName
    ? (vscode.workspace.workspaceFolders?.[0]?.uri.authority || vscode.env.remoteName)
    : os.hostname();
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
  const platform = os.platform();
  if (platform !== 'win32' && platform !== 'linux') return;
  const remote = Boolean(vscode.env.remoteName);
  const cwdValue = value => typeof value === 'string' ? value : value && typeof value.fsPath === 'string' ? value.fsPath : null;
  const absoluteCwd = value => value && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) ? value : null;
  function terminalCwd(terminal) {
    const integrated = absoluteCwd(cwdValue(terminal.shellIntegration?.cwd));
    if (integrated) return { cwd: integrated, cwdSource: 'shellIntegration' };
    const created = cwdValue(terminal.creationOptions?.cwd);
    if (absoluteCwd(created)) return { cwd: created, cwdSource: 'creationOptions' };
    const workspace = workspaceCwd();
    if (created && workspace) {
      const paths = path.win32.isAbsolute(workspace) && !path.posix.isAbsolute(workspace) ? path.win32 : path.posix;
      return { cwd: paths.resolve(workspace, created), cwdSource: 'creationOptions' };
    }
    return { cwd: workspace, ...(workspace ? { cwdSource: 'workspace' } : {}) };
  }

  function atomic(file, data) {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function recordFor(terminal) {
    let record = records.get(terminal);
    if (!record) {
      record = { id: `vsc-${instance}-${crypto.randomBytes(4).toString('hex')}`, generation: crypto.randomBytes(16).toString('hex'), terminal, pid: null, label: terminal.name.slice(0, 100) };
      records.set(terminal, record);
    }
    record.label = terminal.name.slice(0, 100);
    return record;
  }
  function heartbeat() {
    if (disposed) return;
    const terminals = new Set(vscode.window.terminals);
    for (const [terminal, record] of records) {
      if (!terminals.has(terminal)) { records.delete(terminal); shared.delete(record.id); }
    }
    const sessions = [...terminals].map(terminal => {
      const record = recordFor(terminal);
      const isShared = shared.has(record.id);
      return {
        id: record.id, generation: record.generation, label: record.label, machine, ...terminalCwd(terminal), pid: isShared ? record.pid : null,
        alive: !terminal.exitStatus, shared: isShared, platform, remote
      };
    });
    atomic(metadata, { instance, machine, platform, remote, inputProtocol: 'paced-submit-v1', providerVersion: '0.1.7', updatedAt: Date.now(), sessions });
  }
  async function share(terminal) {
    const record = recordFor(terminal);
    if (shared.has(record.id)) return;
    const pid = await terminal.processId;
    if (!vscode.window.terminals.includes(terminal) || terminal.exitStatus) return;
    record.pid = pid || null;
    // A new explicit share is a new grant, even if it is the same live tab.
    record.generation = crypto.randomBytes(16).toString('hex');
    shared.set(record.id, record);
    heartbeat();
    vscode.window.showInformationMessage(`Discord sharing enabled for "${terminal.name}". /sessions shows its ID.`);
  }
  function alive(record) {
    if (disposed || !shared.has(record.id) || !vscode.window.terminals.includes(record.terminal) || record.terminal.exitStatus) {
      throw new Error('Terminal closed or unshared');
    }
  }
  async function snapshot(record) {
    alive(record);
    const generation = record.generation;
    const target = record.terminal;
    const previous = vscode.window.activeTerminal;
    const clipboardBefore = await vscode.env.clipboard.readText();
    const sentinel = `remote-operator-${crypto.randomBytes(16).toString('hex')}`;
    let copied;
    let selectionChanged = false;
    const assertTarget = () => {
      alive(record);
      if (record.generation !== generation) throw new Error('Sharing grant changed');
      if (vscode.window.activeTerminal !== target) throw new Error('Active terminal changed');
    };
    try {
      target.show(false);
      // Wait for terminal activation without sending any keystrokes.
      for (let i = 0; i < 20 && vscode.window.activeTerminal !== target; i++) {
        await new Promise(r => setTimeout(r, 25));
      }
      assertTarget();
      await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
      selectionChanged = true;
      assertTarget();
      await vscode.env.clipboard.writeText(sentinel);
      assertTarget();
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      assertTarget();
      copied = await vscode.env.clipboard.readText();
      assertTarget();
      if (!copied || copied === sentinel) throw new Error('Terminal copy did not produce output');
      return copied.slice(-64 * 1024);
    } finally {
      if (selectionChanged && vscode.window.activeTerminal === target) {
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection').catch(() => {});
      }
      const current = await vscode.env.clipboard.readText();
      // Preserve a newer clipboard edit made by the user while we were copying.
      if (current === sentinel || current === copied) await vscode.env.clipboard.writeText(clipboardBefore);
      if (previous && previous !== target && vscode.window.activeTerminal === target && vscode.window.terminals.includes(previous)) previous.show(true);
    }
  }
  async function handle(file) {
    const pending = path.join(dir, file);
    const claimed = pending.replace('.request.json', '.working');
    try { fs.renameSync(pending, claimed); } catch { return; }
    try {
      const fd = fs.openSync(pending.replace('.request.json', '.seen'), 'wx', 0o600);
      fs.closeSync(fd);
    } catch {
      try { fs.unlinkSync(claimed); } catch {}
      return;
    }
    let req;
    try {
      req = JSON.parse(fs.readFileSync(claimed, 'utf8'));
      if (!req || req.instance !== instance || !/^[a-f0-9]{32}$/.test(req.requestId)
        || file !== `${instance}-${req.requestId}.request.json`
        || !Number.isFinite(req.expiresAt) || req.expiresAt < Date.now() || req.expiresAt > Date.now() + 15_000) throw new Error('Expired or invalid request');
      const record = shared.get(req.sessionId);
      if (!record) throw new Error('Not shared');
      if (req.generation !== undefined && req.generation !== record.generation) throw new Error('Stale terminal generation');
      alive(record);
      const generation = record.generation;
      const assertRequest = () => {
        alive(record);
        if (records.get(record.terminal) !== record || record.generation !== generation || (req.generation !== undefined && req.generation !== record.generation)) throw new Error('Stale terminal generation');
        if (Date.now() >= req.expiresAt) throw new Error('Expired');
      };
      let output = '';
      if (req.action === 'status') output = `provider=vscode version=0.1.7 input=paced-submit-v1 generation=${generation} machine=${machine} pid=${record.pid} alive=true label=${record.label}`;
      else if (req.action === 'output') { output = await snapshot(record); assertRequest(); }
      else if (req.action === 'send' || req.action === 'submit') {
        if (typeof req.text !== 'string' || !req.text || req.text.length > 500 || /[\x00-\x1f\x7f]/.test(req.text)) throw new Error('Invalid input');
        assertRequest();
        record.terminal.sendText(req.text, false);
        if (req.action === 'submit') {
          await new Promise(resolve => setTimeout(resolve, 250));
          assertRequest();
          record.terminal.sendText('\r', false);
          output = 'Text and paced Enter handed to the selected VS Code terminal API; application receipt is not verified';
        } else output = 'Text sent to the selected VS Code terminal API; submit separately with key=enter';
      } else if (req.action === 'key') {
        const sequences = {
          'enter': '\r', 'ctrl-c': '\x03', 'escape': '\x1b', 'tab': '\t',
          'up': '\x1b[A', 'down': '\x1b[B', 'right': '\x1b[C', 'left': '\x1b[D',
          'shift-left': '\x1b[1;2D',
        };
        if (typeof req.key !== 'string' || !Object.prototype.hasOwnProperty.call(sequences, req.key)) throw new Error('Invalid key');
        assertRequest();
        record.terminal.sendText(sequences[req.key], false);
        output = `Key ${req.key} sent to the selected VS Code terminal API`;
      } else if (req.action === 'interrupt') {
        assertRequest();
        record.terminal.sendText('\x03', false);
        output = 'Ctrl-C submitted';
      } else throw new Error('Unknown action');
      assertRequest();
      atomic(path.join(dir, `${instance}-${req.requestId}.response.json`), { requestId: req.requestId, sessionId: req.sessionId, generation: record.generation, ok: true, output });
    } catch {
      if (req && /^[a-f0-9]{32}$/.test(req.requestId) && req.instance === instance) {
        atomic(path.join(dir, `${instance}-${req.requestId}.response.json`), { requestId: req.requestId, sessionId: req.sessionId, generation: req.generation, ok: false });
      }
    } finally { try { fs.unlinkSync(claimed); } catch {} }
  }
  async function poll() {
    if (busy || disposed) return;
    busy = true;
    try {
      heartbeat();
      for (const file of fs.readdirSync(dir).filter(n => n.startsWith(instance + '-') && /^[a-f0-9]{16}-[a-f0-9]{32}\.request\.json$/.test(n))) {
        if (disposed) break;
        await handle(file);
      }
    } catch { /* Local I/O failure exposes no terminal data. */ }
    finally { busy = false; }
  }

  context.subscriptions.push(vscode.commands.registerCommand('remoteOperator.shareTerminal', async () => {
    const choices = vscode.window.terminals.map(terminal => ({ label: terminal.name, terminal }));
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Select a terminal to expose to your Discord owner account' });
    if (selected) await share(selected.terminal);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('remoteOperator.unshareTerminal', async () => {
    const selected = await vscode.window.showQuickPick([...shared.values()].map(s => ({ label: s.label, id: s.id })), { placeHolder: 'Stop sharing (does not stop the process)' });
    if (selected) { shared.delete(selected.id); heartbeat(); }
  }));
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    const record = records.get(terminal);
    if (record) { shared.delete(record.id); records.delete(terminal); }
    heartbeat();
  }));
  const timer = setInterval(poll, 400);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(timer); try { fs.unlinkSync(metadata); } catch {} } });
  heartbeat();


}

module.exports = { activate };
