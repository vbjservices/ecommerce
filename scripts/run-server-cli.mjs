import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const entry = process.argv[2];
if (!entry) throw new Error('A server CLI entry module is required.');
process.argv.splice(2, 1);

const fileValues = {};
for (const file of ['.env', '.env.local']) {
  if (existsSync(file)) Object.assign(fileValues, parseEnv(readFileSync(file, 'utf8')));
}
for (const [name, value] of Object.entries(fileValues)) {
  if (process.env[name] === undefined) process.env[name] = value;
}

await import(pathToFileURL(resolve(entry)).href);
