// libsignal 6.0.0 logs full private session objects independently of Baileys' logger.
// Silence this dependency's console calls, never the application's operational logs.
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
const root = path.resolve("node_modules/libsignal");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (pkg.version !== "6.0.0")
  throw new Error("Review libsignal logging before upgrading");
for (const name of await readdir(path.join(root, "src"))) {
  if (!name.endsWith(".js")) continue;
  const file = path.join(root, "src", name),
    source = await readFile(file, "utf8");
  const safe = source.replace(
    /console\.(?:log|info|debug|warn|error)\s*\(/g,
    "void (",
  );
  if (safe !== source) await writeFile(file, safe);
}
