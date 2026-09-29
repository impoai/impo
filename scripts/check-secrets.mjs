import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
const forbidden = /(^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:p8|p12|pfx|pem|key|mobileprovision|keystore|jks)|Config\.local\.xcconfig)$/;
const privateTrees = /^(?:CJ-images-[^/]+|screenshots|docs\/(?:design|validation|archive)|\.agents|\.claude|\.local)(?:\/|$)/;
const snapshot = await mkdtemp(join(tmpdir(), 'impo-secret-scan-'));
function scan(args) {
  const result = spawnSync('gitleaks', [...args, '--redact=100', '--no-banner', '--ignore-gitleaks-allow'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error('Install Gitleaks before running this check.');
  if (result.status !== 0) throw new Error('Secret scan failed. Review the redacted findings before pushing.');
}
try {
  for (const name of files) {
    const source = join(root, name);
    const stat = await lstat(source).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Review symlink before publishing: ${name}`);
    if (!stat.isFile()) continue;
    if (privateTrees.test(name) || (forbidden.test(name) && !name.endsWith('.env.example'))) {
      throw new Error(`Private/local file is included in the public tree: ${name}`);
    }
    const destination = join(snapshot, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  scan(['dir', snapshot]);
  scan(['git', root, '--log-opts=--all']);
  console.log('PASS: public file inventory and reachable Git history secret checks.');
} finally {
  await rm(snapshot, { recursive: true, force: true });
}
