import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

const SWIREIT_KEYS = [
  'SWIREIT_PROJECT_ID',
  'SWIREIT_API_TOKEN',
  'SWIREIT_SPACE_URL',
  'SWIREIT_CALLER_ID',
  'SWIREIT_TWIML_URL',
  'SWIREIT_VALIDATE_WEBHOOKS'
];

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  const contents = readFileSync(filePath, 'utf8');
  if (!contents.trim()) {
    return {};
  }
  const env = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveSwireitEnv(rootDir) {
  return {
    ...loadEnvFile(join(rootDir, '.env')),
    ...loadEnvFile(join(rootDir, '.env.local')),
    ...process.env
  };
}

function ensureDirectoryExists(dirPath) {
  if (!existsSync(dirPath)) {
    throw new Error(`AISec directory not found: ${dirPath}`);
  }
  const stats = statSync(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`AISec path is not a directory: ${dirPath}`);
  }
}

function updateEnvFile(filePath, values) {
  const existingContents = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const lines = existingContents ? existingContents.split(/\r?\n/) : [];
  const seen = new Set();
  const updatedLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${values[match[1]] ?? ''}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      updatedLines.push(`${key}=${value ?? ''}`);
    }
  }

  const normalized = updatedLines
    .filter((line, index) => index < updatedLines.length - 1 || line.trim() !== '')
    .join('\n')
    .replace(/\n*$/, '\n');
  writeFileSync(filePath, normalized, 'utf8');
}

async function ensureSwireitRunning(env) {
  const spaceUrl = env.SWIREIT_SPACE_URL;
  if (!spaceUrl) {
    console.warn('⚠️  SWIREIT_SPACE_URL is not set; unable to verify Swireit is running.');
    return;
  }

  let baseUrl = spaceUrl.trim();
  if (!baseUrl) {
    console.warn('⚠️  SWIREIT_SPACE_URL is empty; unable to verify Swireit is running.');
    return;
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }

  let healthUrl;
  try {
    healthUrl = new URL('/api/health', baseUrl).toString();
  } catch (error) {
    console.warn(`⚠️  Invalid SWIREIT_SPACE_URL (${spaceUrl}); unable to verify Swireit is running.`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
    console.log(`✅ Swireit is running (${healthUrl}).`);
  } catch (error) {
    console.error(`🚨 Start Swireit before initializing AISec. Health check failed for ${healthUrl}.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const rootDir = process.cwd();
  const aisecDir = process.env.AISEC_DIR || process.env.AISEC_PATH || '../aisec';
  const resolvedAisecDir = resolve(rootDir, aisecDir);

  ensureDirectoryExists(resolvedAisecDir);

  const swireitEnv = resolveSwireitEnv(rootDir);
  const values = SWIREIT_KEYS.reduce((acc, key) => {
    acc[key] = swireitEnv[key] ?? '';
    return acc;
  }, {});

  const missing = SWIREIT_KEYS.filter((key) => !swireitEnv[key]);
  if (missing.length) {
    console.warn(`⚠️  Missing Swireit values: ${missing.join(', ')}`);
  }

  await ensureSwireitRunning(swireitEnv);

  const targetFile = join(resolvedAisecDir, '.env.local');
  updateEnvFile(targetFile, values);
  console.log(`✅ AISec .env.local updated at ${targetFile}`);
}

main().catch((error) => {
  console.error('AISec initialization failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
