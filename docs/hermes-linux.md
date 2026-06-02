# Hermes (Linux) — generar PDF sin ERR_OSSL_UNSUPPORTED

En Linux, el bot suele ejecutar comandos con un **cwd distinto** al repo. El script resuelve rutas desde la raíz del proyecto (`package.json`), no desde el directorio actual de Hermes.

## Configuración recomendada

1. En la máquina Linux, clona o sincroniza `muccam-workflows`.
2. Copia el JSON de la service account (descarga de Google Cloud) a:

   `secrets/google-service-account.json`

   No edites la `private_key` a mano.

3. En `.env` del repo (solo esto para Google):

   ```env
   GOOGLE_APPLICATION_CREDENTIALS="./secrets/google-service-account.json"
   TEMPLATE_DOC_ID="..."
   ```

4. Comenta o borra `GOOGLE_SERVICE_ACCOUNT_JSON` (el JSON inline en `.env` es lo que más rompe la clave en Linux).

## Comandos para Hermes

Ejecutar **desde el repo** o con ruta absoluta al script; siempre con `dotenv`:

```bash
cd /ruta/a/muccam-workflows
corepack pnpm run verify:auth:diagnostico
corepack pnpm run verify:auth
corepack pnpm exec tsx -r dotenv/config generar_pdf_desde_template.ts \
  --data examples/carta-muccam.json \
  --output output/carta-muccam.pdf
```

Si `literalBackslashNCount` > 0 y `hasRealNewlines` es false en el diagnóstico, la clave sigue mal escapada.

## Migrar desde .env inline (una vez)

Si aún tienes `GOOGLE_SERVICE_ACCOUNT_JSON` en Mac/Linux:

```bash
corepack pnpm run setup:google-credentials
```

Luego actualiza `.env` como arriba.

## Qué debe hacer Hermes

- Usar el mismo `.env` que está en la raíz del repo.
- No reescribir el JSON de la service account en su propia config (suele corromper `\\n`).
- Preferir ruta absoluta si el cwd del bot no es el repo:

  `GOOGLE_APPLICATION_CREDENTIALS="/home/TU_USER/muccam-workflows/secrets/google-service-account.json"`
