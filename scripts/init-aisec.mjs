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
const HEALTH_CHECK_TIMEOUT_MS = 3000;

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
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const endIndex = value.indexOf(quote, 1);
      if (endIndex >= 0) {
        value = value.slice(1, endIndex);
      } else {
        console.warn(`⚠️  Unterminated quote for ${key} in ${filePath}. Check for matching quotes.`);
        value = value.slice(1);
      }
    } else {
      const commentIndex = value.indexOf('#');
      if (commentIndex >= 0) {
        value = value.slice(0, commentIndex).trim();
      }
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
  const lines = existingContents.split(/\r?\n/);
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

  while (updatedLines.length && updatedLines[updatedLines.length - 1].trim() === '') {
    updatedLines.pop();
  }
  const normalized = `${updatedLines.join('\n')}\n`;
  writeFileSync(filePath, normalized, 'utf8');
}

async function verifySwireitRunning(env) {
  const spaceUrl = env.SWIREIT_SPACE_URL;
  if (!spaceUrl) {
    console.warn('⚠️  SWIREIT_SPACE_URL is not set; unable to verify Swireit is running.');
    return;
  }

  const trimmedUrl = spaceUrl.trim();
  if (!trimmedUrl) {
    console.warn('⚠️  SWIREIT_SPACE_URL is empty; unable to verify Swireit is running.');
    return;
  }

  let healthUrl;
  try {
    const targetUrl = trimmedUrl.startsWith('http')
      ? trimmedUrl
      : (/^(localhost|127\.0\.0\.1|(?:\[::1\]|::1))(:\d+)?$/i.test(trimmedUrl)
        ? `http://${trimmedUrl}`
        : `https://${trimmedUrl}`);
    if (!trimmedUrl.startsWith('http') && targetUrl.startsWith('https://')) {
      console.warn(`⚠️  Defaulting to HTTPS for SWIREIT_SPACE_URL (${trimmedUrl}).`);
    }
    healthUrl = new URL('/api/health', targetUrl).toString();
  } catch (error) {
    console.warn(`⚠️  Invalid SWIREIT_SPACE_URL (${spaceUrl}); unable to verify Swireit is running.`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
    console.log(`✅ Swireit is running (${healthUrl}).`);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(
      `🚨 Start Swireit before initializing AISec. Health check failed for ${healthUrl}. (${details})`
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const rootDir = process.cwd();
  const aisecDir = process.env.AISEC_DIR || '../aisec';
  const resolvedAisecDir = resolve(rootDir, aisecDir);

  ensureDirectoryExists(resolvedAisecDir);

  const swireitEnv = resolveSwireitEnv(rootDir);
  const values = Object.fromEntries(
    SWIREIT_KEYS.map((key) => [key, swireitEnv[key] ?? ''])
  );

  const missing = SWIREIT_KEYS.filter((key) => !swireitEnv[key]);
  if (missing.length) {
    console.warn(`⚠️  Missing Swireit values: ${missing.join(', ')}`);
  }

  await verifySwireitRunning(swireitEnv);

  const targetFile = join(resolvedAisecDir, '.env.local');
  updateEnvFile(targetFile, values);
  console.log(`✅ AISec .env.local updated at ${targetFile}`);
}

main().catch((error) => {
  console.error('AISec initialization failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
