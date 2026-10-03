import { mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

if (!['linux', 'win32'].includes(process.platform)) throw new Error('Build agent bundles on their target Windows or Linux host.');
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath;
if (!npm || !existsSync(npm)) throw new Error('Run via npm run agent:package.');
const compiled = resolve(root, 'dist/apps/discord');
const modules = new Set();
const external = new Set();

// Follow compiled imports from the agent entry points. Stale bot/test/demo files
// in dist are never copied merely because they share the directory.
function includeModule(file) {
  if (!file.startsWith(compiled + sep) || !file.endsWith('.js')) throw new Error('Agent helper must be a compiled bridge module.');
  if (modules.has(file)) return;
  modules.add(file);
  if (modules.size > 256) throw new Error('Agent module graph exceeds the supported bound.');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  function includeImport(specifier) {
    if (specifier.startsWith('node:')) return;
    if (specifier.startsWith('.')) includeModule(resolve(dirname(file), specifier));
    else external.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      includeImport(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      includeImport(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
includeModule(resolve(compiled, 'agent-cli.js'));
includeModule(resolve(compiled, 'agent-tunnel.js'));
// The Windows supervisor is launched by filename rather than imported.
if (process.platform === 'win32') includeModule(resolve(compiled, 'pty-supervisor.js'));

const dependencies = {};
for (const name of [...external].sort()) {
  const selected = JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (manifest.dependencies?.[name] !== selected) throw new Error(`Agent runtime dependency ${name} must match the validated manifest version.`);
  dependencies[name] = selected;
}
const target = `${process.platform}-${process.arch}`;
const release = resolve(root, '.discord-bridge/releases', `discordremote-agent-${manifest.version}-${target}-${Date.now()}`);
mkdirSync(release, { recursive: true, mode: 0o700 });
for (const file of [...modules].sort()) {
  const destination = resolve(release, 'dist/apps/discord', file.slice(compiled.length + 1));
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(file, destination);
}
cpSync(resolve(root, 'docs/AGENT-DEPLOYMENT.md'), resolve(release, 'README.md'));
cpSync(resolve(root, 'LICENSE'), resolve(release, 'LICENSE'));
cpSync(resolve(root, '.env.coordinator.example'), resolve(release, '.env.coordinator.example'));
writeFileSync(resolve(release, 'package.json'), JSON.stringify({
  name: 'discordremote-agent', version: manifest.version, private: true, license: manifest.license,
  type: 'module', engines: manifest.engines,
  scripts: {
    'agent:pair': 'node dist/apps/discord/agent-cli.js pair',
    'agent:start': 'node dist/apps/discord/agent-cli.js start',
    'agent:tunnel': 'node dist/apps/discord/agent-tunnel.js',
  }, dependencies,
}, null, 2) + '\n');
execFileSync(process.execPath, [npm, 'install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], {
  cwd: release, stdio: 'inherit', windowsHide: true, timeout: 180_000,
});
// This validates native code on the actual target OS; it never starts a terminal.
if (process.platform === 'win32') {
  execFileSync(process.execPath, ['--input-type=module', '-e', "import('node-pty').then(() => console.log('Native PTY module loaded'))"], {
    cwd: release, stdio: 'inherit', windowsHide: true, timeout: 30_000,
  });
} else execFileSync(process.env.TMUX_BIN || 'tmux', ['-V'], { cwd: release, stdio: 'inherit', timeout: 10_000 });
const archive = `${release}.tgz`;
execFileSync('tar', ['-czf', archive, '-C', release, '.'], { windowsHide: true, timeout: 120_000 });
const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha}  ${archive.split(/[\\/]/).pop()}\n`);
console.log(`Bundle: ${archive}\nSHA256: ${sha}\nPlatform: ${target}. Requires Node.js >=22. No enrollment, bot token or local state included.`);
