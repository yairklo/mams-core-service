import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const src = path.join(projectRoot, "prompts");
const dest = path.join(projectRoot, "dist", "prompts");

fs.cpSync(src, dest, { recursive: true });
console.log(`[copyAgentSystemAssets] Copied "${src}" -> "${dest}"`);

const seedsSrc = path.join(projectRoot, "seeds");
const seedsDest = path.join(projectRoot, "dist", "seeds");
if (fs.existsSync(seedsSrc)) {
  fs.cpSync(seedsSrc, seedsDest, { recursive: true });
  console.log(`[copyAgentSystemAssets] Copied "${seedsSrc}" -> "${seedsDest}"`);
}
