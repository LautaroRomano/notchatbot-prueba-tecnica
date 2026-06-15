/**
 * Ejecuta `convex run <fn> <json>` sin shell, leyendo el JSON desde un archivo.
 * Evita un bug de Windows donde `bunx` reescribe argv y borra comillas del JSON.
 *
 * Uso (desde apps/demo/):
 *   bun run convex:run-json -- sync:setConfig ./scripts/sync-set-config.local.json
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const require = createRequire(join(appRoot, "package.json"));
const convexRoot = dirname(require.resolve("convex/package.json"));
const convexBin = join(convexRoot, "bin", "main.js");

const fn = process.argv[2];
const jsonPath = process.argv[3];

if (!fn || !jsonPath) {
  console.error(
    [
      "Uso: node scripts/convex-run-json.mjs <modulo:función> <ruta-al.json>",
      "Ejemplo: bun run convex:run-json -- sync:setConfig ./scripts/sync-set-config.local.json",
    ].join("\n"),
  );
  process.exit(1);
}

let jsonArg;
try {
  const raw = readFileSync(jsonPath, "utf8");
  jsonArg = JSON.stringify(JSON.parse(raw));
} catch (e) {
  console.error(`No se pudo leer o parsear JSON en ${jsonPath}:`, e.message);
  process.exit(1);
}

const result = spawnSync(process.execPath, [convexBin, "run", fn, jsonArg], {
  cwd: appRoot,
  stdio: "inherit",
  shell: false,
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
