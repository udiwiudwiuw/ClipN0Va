import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Maakt een schone SQLite testdatabase aan (prisma/test.db). */
export default function setup() {
  const root = path.resolve(__dirname, "..");
  fs.rmSync(path.join(root, "prisma", "test.db"), { force: true });
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: root,
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });
  return () => {
    fs.rmSync(path.join(root, "prisma", "test.db"), { force: true });
    fs.rmSync(path.join(root, ".unused-test-dir"), { recursive: true, force: true });
  };
}
