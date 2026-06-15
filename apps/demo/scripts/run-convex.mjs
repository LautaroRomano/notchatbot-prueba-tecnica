/**
 * Wrapper que lanza la CLI de Convex usando su ubicación real en la caché de
 * bun (.bun/convex@<ver>/node_modules/convex/bin/main.js), sin depender de
 * que bun haya creado el junction en apps/demo/node_modules/convex (bug de
 * bun v1.3.x en Windows).
 *
 * Uso: node ./scripts/run-convex.mjs <args...>
 * Ejemplos:
 *   node ./scripts/run-convex.mjs dev
 *   node ./scripts/run-convex.mjs run seed:run
 */
import { spawn } from "child_process";
import { readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
// apps/demo/scripts/ → apps/demo/ → apps/ → <root>
const root = resolve(scriptDir, "../../..");
const bunCache = resolve(root, "node_modules", ".bun");

if (!existsSync(bunCache)) {
  console.error("node_modules/.bun no existe — corré bun install primero.");
  process.exit(1);
}

const convexDir = readdirSync(bunCache).find((d) => d.startsWith("convex@"));
if (!convexDir) {
  console.error("convex no encontrado en node_modules/.bun — corré bun install.");
  process.exit(1);
}

const mainJs = resolve(
  bunCache,
  convexDir,
  "node_modules",
  "convex",
  "bin",
  "main.js",
);

if (!existsSync(mainJs)) {
  console.error(`No existe ${mainJs} — instalación de convex corrupta.`);
  process.exit(1);
}

// NODE_PATH permite que los subprocesos de "use node" de Convex encuentren
// los paquetes workspace (@notchat/duck-destination, etc.) aunque corran
// desde un directorio temporal donde no hay node_modules.
const nodePaths = [
  resolve(root, "apps", "demo", "node_modules"),
  resolve(root, "packages", "duck-destination", "node_modules"),
].join(process.platform === "win32" ? ";" : ":");

const duckDestPath = resolve(root, "packages", "duck-destination");

const env = {
  ...process.env,
  NODE_PATH: process.env.NODE_PATH
    ? `${nodePaths}${process.platform === "win32" ? ";" : ":"}${process.env.NODE_PATH}`
    : nodePaths,
  // Ruta absoluta al paquete duck-destination. snapshot.ts la usa para
  // construir un file:// URL y bypasear la resolución de módulos de Node.
  CONVEX_DUCK_PATH: duckDestPath,
};

const args = process.argv.slice(2);
const child = spawn(process.execPath, [mainJs, ...args], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
