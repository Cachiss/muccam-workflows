import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { google } from 'googleapis';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
] as const;

function createGoogleAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.resolve(requireEnv('GOOGLE_APPLICATION_CREDENTIALS')),
    scopes: [...GOOGLE_SCOPES],
  });
}

type TemplateData = Record<string, string | number | boolean | null | undefined>;

type GeneratePdfInput = {
  templateDocId: string;
  outputPath: string;
  data: TemplateData;
};

type GeneratePdfResult = {
  outputPath: string;
};

/** Capítulo y organización fijos para todas las cartas de este flujo. */
const FIXED_TEMPLATE_FIELDS: TemplateData = {
  CAPITULO: 'San Juan del Rio',
  ORGANIZACION: 'MUCCAM A.C. Capitulo San Juan del Rio',
};

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }

  return value;
}

function normalizeGoogleFileId(value: string, label: string): string {
  const trimmedValue = value.trim();
  const urlMatch = trimmedValue.match(/\/(?:document\/d|folders)\/([a-zA-Z0-9_-]+)/);
  const queryMatch = trimmedValue.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const id = urlMatch?.[1] ?? queryMatch?.[1] ?? trimmedValue;

  if (id.length < 20) {
    throw new Error(
      `${label} must be a Google Drive file/folder ID or URL. Received "${value}", which looks like a name instead of an ID.`,
    );
  }

  return id;
}

function createReplaceRequests(data: TemplateData) {
  return Object.entries(data).map(([key, value]) => ({
    replaceAllText: {
      containsText: {
        text: `{{${key}}}`,
        matchCase: true,
      },
      replaceText: value == null ? '' : String(value),
    },
  }));
}

function createRestoreRequests(data: TemplateData) {
  return Object.entries(data)
    .reverse()
    .map(([key, value]) => ({
      replaceAllText: {
        containsText: {
          text: value == null ? '' : String(value),
          matchCase: true,
        },
        replaceText: `{{${key}}}`,
      },
    }))
    .filter((request) => request.replaceAllText.containsText.text.length > 0);
}

async function withLocalLock<T>(lockPath: string, callback: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lockFile = await open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new Error(`Template is already being used. Lock exists at: ${lockPath}`);
    }

    throw error;
  });

  try {
    return await callback();
  } finally {
    await lockFile.close();
    await rm(lockPath, { force: true });
  }
}

export async function generatePdfByEditingTemplate({
  templateDocId,
  outputPath,
  data,
}: GeneratePdfInput): Promise<GeneratePdfResult> {
  const auth = createGoogleAuth();
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });
  const documentId = normalizeGoogleFileId(templateDocId, 'templateDocId');
  const lockPath = path.join(process.cwd(), '.locks', `${documentId}.lock`);

  return withLocalLock(lockPath, async () => {
    let shouldRestore = false;

    try {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: createReplaceRequests(data),
        },
      });
      shouldRestore = true;

      const pdf = await drive.files.export(
        {
          fileId: documentId,
          mimeType: 'application/pdf',
        },
        {
          responseType: 'arraybuffer',
        },
      );

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from(pdf.data as ArrayBuffer));

      return { outputPath };
    } finally {
      if (shouldRestore) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: createRestoreRequests(data),
          },
        });
      }
    }
  });
}

const CLI_USAGE = `Usage: tsx generar_pdf_desde_template.ts --data <json-file> [--output <pdf-path>] [--template-id <id>]

Options:
  -d, --data          JSON file with template placeholders (keys match {{KEY}} in the doc)
  -o, --output        Output PDF path (default: output/carta-muccam.pdf)
  -t, --template-id   Google Docs template ID (default: TEMPLATE_DOC_ID env)`;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      data: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o' },
      'template-id': { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(CLI_USAGE);
    process.exit(0);
  }

  const dataPath = values.data;

  if (!dataPath) {
    throw new Error(`Missing required option: --data\n\n${CLI_USAGE}`);
  }

  return {
    dataPath: path.resolve(dataPath),
    outputPath: path.resolve(values.output ?? path.join(process.cwd(), 'output', 'carta-muccam.pdf')),
    templateDocId: values['template-id'] ?? requireEnv('TEMPLATE_DOC_ID'),
  };
}

async function loadTemplateData(filePath: string): Promise<TemplateData> {
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Data file must contain a JSON object: ${filePath}`);
  }

  return { ...(parsed as TemplateData), ...FIXED_TEMPLATE_FIELDS };
}

async function main() {
  const { dataPath, outputPath, templateDocId } = parseCliArgs();
  const data = await loadTemplateData(dataPath);

  const result = await generatePdfByEditingTemplate({
    templateDocId,
    outputPath,
    data,
  });

  console.log(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
