import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// A local VSIX needs the OPC manifest, extension files and their MIT license.
// Store ZIP entries directly so packaging works with Node alone on either host.
const root = fileURLToPath(new URL('../', import.meta.url));
const folder = resolve(root, 'apps/vscode-bridge');
const pkg = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
const xml = value => String(value).replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}"/>
<DisplayName>${xml(pkg.displayName)}</DisplayName><Description xml:space="preserve">${xml(pkg.description)}</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`;
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="txt" ContentType="text/plain"/></Types>`;
const files = [
  ['extension.vsixmanifest', Buffer.from(manifest)], ['[Content_Types].xml', Buffer.from(contentTypes)],
  ['extension/package.json', readFileSync(resolve(folder, 'package.json'))],
  ['extension/extension.cjs', readFileSync(resolve(folder, 'extension.cjs'))],
  ['extension/LICENSE.txt', readFileSync(resolve(root, 'LICENSE'))],
];
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const entries = [], directory = [];
let offset = 0;
for (const [filename, bytes] of files) {
  const name = Buffer.from(filename), crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  entries.push(local, name, bytes); directory.push(central, name); offset += local.length + name.length + bytes.length;
}
const end = Buffer.alloc(22), central = Buffer.concat(directory);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...entries, central, end]);
const output = resolve(root, '.discord-bridge', `${pkg.name}-${pkg.version}.vsix`);
mkdirSync(resolve(root, '.discord-bridge'), { recursive: true, mode: 0o700 });
writeFileSync(output, archive, { mode: 0o600 });
console.log(JSON.stringify({ path: output, version: pkg.version, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }));
