import { exportServiceAccountToSecretsFile, findProjectRoot } from './google_auth.js';

async function main() {
  const outPath = await exportServiceAccountToSecretsFile();
  const projectRoot = await findProjectRoot();

  console.log(`Credenciales exportadas a: ${outPath}`);
  console.log('');
  console.log('En tu .env de Linux (Hermes), usa solo esto y comenta GOOGLE_SERVICE_ACCOUNT_JSON:');
  console.log(`GOOGLE_APPLICATION_CREDENTIALS="${pathRelative(projectRoot, outPath)}"`);
}

function pathRelative(root: string, filePath: string): string {
  const rel = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
  return `./${rel}`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
