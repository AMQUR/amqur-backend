import * as fs from 'fs';
import * as path from 'path';

/** Load disposable test env if present (never production). */
const envPath = path.resolve(__dirname, '../test-infra/.env.test');
if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long!!';
}
