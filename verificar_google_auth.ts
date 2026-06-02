import { verifyGoogleAuth } from './google_auth.js';

const diagnose = process.argv.includes('--diagnostico');

verifyGoogleAuth({ diagnose }).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
