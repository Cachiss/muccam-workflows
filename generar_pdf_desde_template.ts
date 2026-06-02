import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

type TemplateData = Record<string, string | number | boolean | null | undefined>;

type GeneratePdfInput = {
  templateDocId: string;
  outputPath: string;
  data: TemplateData;
};

type GeneratePdfResult = {
  outputPath: string;
};

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
] as const;

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

function createGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON')),
    scopes: [...SCOPES],
  });
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

async function main() {
  const result = await generatePdfByEditingTemplate({
    templateDocId: requireEnv('TEMPLATE_DOC_ID'),
    outputPath: path.join(process.cwd(), 'output', 'carta-muccam.pdf'),
    data: {
      CAPITULO: 'San Juan del Rio',
      ASUNTO: 'Solicitud de apoyo para platicas informativas',
      DESTINATARIO: 'Dr. Juan Carlos Quiroz Gomez',
      FECHA: '21 de mayo de 2026',
      PRESENTE: 'P R E S E N T E',
      CUERPO_1:
        'Por medio de la presente, la asociacion MUCCAM A.C. Capitulo San Juan del Rio solicita de la manera mas atenta su valioso apoyo para llevar a cabo platicas informativas dirigidas a nuestra comunidad y poblacion beneficiaria, con el objetivo de fomentar la prevencion, orientacion y concientizacion en temas de salud.',
      CUERPO_2:
        'Agradecemos de antemano la atencion brindada a esta peticion y quedamos en espera de una respuesta favorable, reiterando nuestra disposicion para trabajar en conjunto en beneficio de la comunidad. Sin mas por el momento, reciba un cordial saludo.',
      FIRMA_NOMBRE: 'Ma. Esther Ramirez Avila',
      FIRMA_CARGO: 'Presidenta',
      ORGANIZACION: 'MUCCAM A.C. Capitulo San Juan del Rio',
      TELEFONO: '427 108 3265',
    },
  });

  console.log(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
