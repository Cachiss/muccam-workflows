import { createPrivateKey } from 'node:crypto';
import { access } from 'node:fs/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

export const GOOGLE_AUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
] as const;

const DEFAULT_CREDENTIALS_RELATIVE = path.join('secrets', 'google-service-account.json');

type ServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
};

export type GoogleCredentialsDiagnostics = {
  platform: string;
  nodeVersion: string;
  cwd: string;
  projectRoot: string;
  credentialMode: 'file' | 'inline' | 'default-file' | 'missing';
  credentialsPath: string | null;
  privateKeyLength: number | null;
  privateKeyLineCount: number | null;
  hasRealNewlines: boolean | null;
  literalBackslashNCount: number | null;
};

function getModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Raíz del repo (donde está package.json), aunque Hermes ejecute desde otro cwd. */
export async function findProjectRoot(): Promise<string> {
  const candidates = [process.cwd(), getModuleDir()];

  for (const startDir of candidates) {
    let current = path.resolve(startDir);

    while (true) {
      if (await pathExists(path.join(current, 'package.json'))) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }

      current = parent;
    }
  }

  return process.cwd();
}

export async function resolveProjectPath(relativeOrAbsolutePath: string): Promise<string> {
  if (path.isAbsolute(relativeOrAbsolutePath)) {
    return relativeOrAbsolutePath;
  }

  const projectRoot = await findProjectRoot();
  return path.resolve(projectRoot, relativeOrAbsolutePath);
}

function normalizePrivateKey(privateKey: string): string {
  let key = privateKey.trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  key = key.replace(/\r/g, '');

  while (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }

  return key.replace(/\n{3,}/g, '\n\n').trim();
}

function assertPrivateKeyCanSign(privateKey: string): void {
  try {
    createPrivateKey(privateKey);
  } catch (error) {
    const hint =
      process.platform === 'linux'
        ? ' En Linux/Hermes suele bastar con copiar el JSON original a secrets/ y usar GOOGLE_APPLICATION_CREDENTIALS (ruta absoluta o relativa al repo).'
        : ' Usa GOOGLE_APPLICATION_CREDENTIALS apuntando al JSON de Google Cloud.';

    throw new Error(
      `La private_key no es un PEM válido para firmar (ERR_OSSL_UNSUPPORTED).${hint}`,
      { cause: error },
    );
  }
}

function normalizeServiceAccountCredentials(
  credentials: ServiceAccountCredentials,
): ServiceAccountCredentials {
  const privateKey = credentials.private_key;

  if (typeof privateKey !== 'string' || privateKey.length === 0) {
    throw new Error('Service account JSON is missing private_key.');
  }

  const normalizedKey = normalizePrivateKey(privateKey);

  if (!normalizedKey.includes('-----BEGIN')) {
    throw new Error(
      'Invalid service account private_key (missing PEM header). Use GOOGLE_APPLICATION_CREDENTIALS with the JSON file from Google Cloud.',
    );
  }

  assertPrivateKeyCanSign(normalizedKey);

  return { ...credentials, private_key: normalizedKey };
}

async function parseServiceAccountJson(raw: string, sourceLabel: string): Promise<ServiceAccountCredentials> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse service account JSON from ${sourceLabel}.`, { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Service account JSON from ${sourceLabel} must be an object.`);
  }

  return normalizeServiceAccountCredentials(parsed as ServiceAccountCredentials);
}

async function materializeCredentialsFile(credentials: ServiceAccountCredentials): Promise<string> {
  const projectRoot = await findProjectRoot();
  const keyFile = path.join(projectRoot, '.locks', 'google-service-account.runtime.json');
  await mkdir(path.dirname(keyFile), { recursive: true });
  await writeFile(keyFile, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  return keyFile;
}

async function resolveCredentialsPathFromEnv(): Promise<string | null> {
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

  if (fromEnv) {
    return resolveProjectPath(fromEnv);
  }

  const projectRoot = await findProjectRoot();
  const defaultPath = path.join(projectRoot, DEFAULT_CREDENTIALS_RELATIVE);

  if (await pathExists(defaultPath)) {
    return defaultPath;
  }

  return null;
}

export async function getGoogleCredentialsDiagnostics(): Promise<GoogleCredentialsDiagnostics> {
  const projectRoot = await findProjectRoot();
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const defaultPath = path.join(projectRoot, DEFAULT_CREDENTIALS_RELATIVE);

  let credentialMode: GoogleCredentialsDiagnostics['credentialMode'] = 'missing';
  let credentialsPath: string | null = null;

  if (fromEnv) {
    credentialMode = 'file';
    credentialsPath = await resolveProjectPath(fromEnv);
  } else if (await pathExists(defaultPath)) {
    credentialMode = 'default-file';
    credentialsPath = defaultPath;
  } else if (inlineJson) {
    credentialMode = 'inline';
  }

  let privateKey: string | null = null;

  if (credentialMode === 'inline' && inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson) as ServiceAccountCredentials;
      privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : null;
    } catch {
      privateKey = null;
    }
  } else if (credentialsPath) {
    try {
      const raw = await readFile(credentialsPath, 'utf8');
      const parsed = JSON.parse(raw) as ServiceAccountCredentials;
      privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : null;
    } catch {
      privateKey = null;
    }
  }

  return {
    platform: process.platform,
    nodeVersion: process.version,
    cwd: process.cwd(),
    projectRoot,
    credentialMode,
    credentialsPath,
    privateKeyLength: privateKey?.length ?? null,
    privateKeyLineCount: privateKey ? privateKey.split('\n').length : null,
    hasRealNewlines: privateKey ? privateKey.includes('\n') : null,
    literalBackslashNCount: privateKey ? (privateKey.match(/\\n/g) ?? []).length : null,
  };
}

async function resolveServiceAccountKeyFile(): Promise<string> {
  const credentialsPath = await resolveCredentialsPathFromEnv();

  if (credentialsPath) {
    const raw = await readFile(credentialsPath, 'utf8');
    await parseServiceAccountJson(raw, credentialsPath);
    return credentialsPath;
  }

  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!inlineJson) {
    throw new Error(
      'Missing Google credentials: set GOOGLE_APPLICATION_CREDENTIALS, place secrets/google-service-account.json in the repo, or set GOOGLE_SERVICE_ACCOUNT_JSON.',
    );
  }

  const credentials = await parseServiceAccountJson(inlineJson, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  return materializeCredentialsFile(credentials);
}

export async function exportServiceAccountToSecretsFile(): Promise<string> {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!inlineJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set; nothing to export.');
  }

  const credentials = await parseServiceAccountJson(inlineJson, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  const projectRoot = await findProjectRoot();
  const outPath = path.join(projectRoot, DEFAULT_CREDENTIALS_RELATIVE);

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });

  return outPath;
}

export async function createGoogleAuth() {
  const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    const oauth2 = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    oauth2.setCredentials({ refresh_token: oauthRefreshToken });
    return oauth2;
  }

  const keyFile = await resolveServiceAccountKeyFile();

  return new google.auth.GoogleAuth({
    keyFile,
    scopes: [...GOOGLE_AUTH_SCOPES],
  });
}

export async function verifyGoogleAuth(options?: { diagnose?: boolean }): Promise<void> {
  if (options?.diagnose) {
    const diagnostics = await getGoogleCredentialsDiagnostics();
    console.log('Diagnóstico de credenciales Google:');
    console.log(JSON.stringify(diagnostics, null, 2));
  }

  const auth = await createGoogleAuth();
  let accessToken: string | null | undefined;

  if ('getClient' in auth && typeof auth.getClient === 'function') {
    const client = await auth.getClient();
    const response = await client.getAccessToken();
    accessToken = typeof response === 'string' ? response : response?.token;
  } else {
    const response = await auth.getAccessToken();
    accessToken = typeof response === 'string' ? response : response?.token;
  }

  if (!accessToken) {
    throw new Error('Google auth succeeded but no access token was returned.');
  }

  const credentialsPath = await resolveCredentialsPathFromEnv();
  const mode = credentialsPath
    ? `archivo (${credentialsPath})`
    : process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? 'GOOGLE_SERVICE_ACCOUNT_JSON'
      : 'OAuth';

  console.log(`Google auth OK — ${mode}`);
}
