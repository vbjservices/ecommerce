import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

// Only the compiled entry and flat asset files may be copied into the Pages root.
const root = resolve(import.meta.dirname, '..');
const assets = await readdir(resolve(root, 'dist/assets'));
if (assets.some(name => !/^[\w.-]+\.(?:js|css)$/.test(name))) throw new Error('Unexpected build asset');
const files = ['index.html', ...assets.map(name => `assets/${name}`)];
const check = process.argv.includes('--check');
for (const file of files) {
  const target = resolve(root, file);
  if (relative(root, target).startsWith('..')) throw new Error('Invalid Pages path');
  const compiled = await readFile(resolve(root, 'dist', file));
  if (check) {
    const committed = await readFile(target).catch(() => null);
    if (!committed?.equals(compiled)) throw new Error(`Stale Pages output: ${file}. Run npm run pages:build.`);
  } else {
    await mkdir(resolve(root, 'assets'), { recursive: true });
    await writeFile(target, compiled);
  }
}
console.log(check ? 'Pages output matches the build.' : 'Pages output staged at repository root.');
