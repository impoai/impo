import {spawnSync} from 'node:child_process';
import {cp, mkdir} from 'node:fs/promises';
const build = spawnSync('npm', ['--workspace', '@impo/web', 'run', 'build'], {stdio: 'inherit'});
if (build.status !== 0) process.exit(build.status || 1);
await mkdir('site/app', {recursive: true});
// Keep previous hashed chunks available to tabs that were open during deploy.
await cp('web/dist', 'site/app', {recursive: true});
console.log('Web client staged in site/app.');
