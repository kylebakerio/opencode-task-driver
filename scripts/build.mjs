// Builds dist/opencode-task-driver.js: src/core.js inlined into src/plugin.js, one file, no imports beyond node
// builtins, exactly one export (TaskDriver). opencode calls every function a plugin module exports as a plugin, and a
// file mounted on its own (a sandbox, a copy in a config dir) cannot resolve a relative import, hence one file.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = fs.readFileSync(path.join(root, "src/core.js"), "utf8");
const plugin = fs.readFileSync(path.join(root, "src/plugin.js"), "utf8");

const names = [...core.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
if (!names.length) throw new Error("no exports found in src/core.js");
const coreBody = core.replace(/^export (?=(?:async )?(?:function|const|let|class) )/gm, "");
if (/^\s*(import|export)\b/m.test(coreBody)) throw new Error("src/core.js must have no imports and only `export function|const` exports");

const IMPORT = 'import * as core from "./core.js";';
if (!plugin.includes(IMPORT)) throw new Error(`src/plugin.js must contain: ${IMPORT}`);
const inlined = `const core = (() => {\n${coreBody.trim()}\nreturn { ${names.join(", ")} };\n})();`;
const body = plugin.replace(IMPORT, () => inlined);   // a function: "$`", "$&" etc. in the source are not replacement patterns
const exportsLeft = [...body.matchAll(/^export /gm)].length;
if (exportsLeft !== 1) throw new Error(`the built file must have exactly one export, found ${exportsLeft}`);

const version = (core.match(/export const VERSION = "([^"]+)"/) || [])[1] || "?";
const srcHash = crypto.createHash("sha256").update(core).update(plugin).digest("hex").slice(0, 16);
const header = `// opencode-task-driver ${version} -- built from src/core.js + src/plugin.js (source sha256 ${srcHash}). Do not edit; run \`npm run build\`.\n`;
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const out = path.join(root, "dist/opencode-task-driver.js");
fs.writeFileSync(out, header + body);
console.log(`wrote ${path.relative(root, out)} (${(header + body).length} bytes, core exports inlined: ${names.length})`);
