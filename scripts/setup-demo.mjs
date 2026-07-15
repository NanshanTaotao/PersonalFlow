import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoDbPath = path.join(rootDir, "examples", "demo", "personalflow-demo.sqlite");
const runtimeDir = path.join(rootDir, "apps", "api", ".personalflow");
const runtimeDbPath = path.join(runtimeDir, "personalflow.sqlite");
const envExamplePath = path.join(rootDir, ".env.example");
const envPath = path.join(rootDir, ".env");

const exists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const ensureFileCopied = async ({ from, to, label }) => {
  if (await exists(to)) {
    console.log(`${label} already exists: ${path.relative(rootDir, to)}`);
    return;
  }
  if (!(await exists(from))) {
    throw new Error(`${label} source is missing: ${path.relative(rootDir, from)}`);
  }
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log(`${label} created: ${path.relative(rootDir, to)}`);
};

await ensureFileCopied({
  from: envExamplePath,
  to: envPath,
  label: "Local environment"
});

await ensureFileCopied({
  from: demoDbPath,
  to: runtimeDbPath,
  label: "Demo database"
});

console.log("PersonalFlow demo setup is ready.");
