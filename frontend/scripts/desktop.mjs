// Builds the desktop app (frontend/desktop, Wails + Go).
//
//   npm run desktop              static web build → copy into desktop/dist → wails build
//   npm run desktop -- --no-web  reuse the last web build in out/
//
// Backend address: .env.desktop if it exists, else .env.capacitor (see .env.desktop.example).
// Output: desktop/build/bin/demo-discord(.exe)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = join(root, "desktop");
const isWin = process.platform === "win32";
const WAILS = "github.com/wailsapp/wails/v2/cmd/wails@v2.17.0";

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
}

function haveGo() {
  try {
    execFileSync("go", ["version"], { stdio: "ignore", shell: isWin });
    return true;
  } catch {
    return false;
  }
}

if (!haveGo()) {
  console.error("Go is not installed. Get it from https://go.dev/dl/ (1.26 or newer), then run this again.");
  process.exit(1);
}

if (!process.argv.includes("--no-web")) {
  const envFile = [".env.desktop", ".env.capacitor"].find((f) => existsSync(join(root, f)));
  if (envFile) console.log(`Using backend settings from ${envFile}`);
  else console.log("No .env.desktop or .env.capacitor: the app will use the default backend (localhost).");
  // Same static export as the phone apps.
  const dotenv = envFile ? ["dotenv", "-e", envFile, "-v", "BUILD_TARGET=capacitor", "--"] : ["dotenv", "-v", "BUILD_TARGET=capacitor", "--"];
  run("npx", [...dotenv, "next", "build"], { cwd: root });
  run("node", ["scripts/strip-downloads.mjs"], { cwd: root });
}

const out = join(root, "out");
if (!existsSync(join(out, "index.html"))) {
  console.error("No web build in out/. Run without --no-web first.");
  process.exit(1);
}

// Go can only embed files inside its own folder, so copy the web build there.
const dist = join(desktopDir, "dist");
rmSync(dist, { recursive: true, force: true });
cpSync(out, dist, { recursive: true });
console.log("Copied out/ into desktop/dist/");

// `go run` fetches the Wails CLI on first use, so nothing needs installing globally.
run("go", ["run", WAILS, "build", "-s", "-skipbindings", "-clean", "-trimpath"], { cwd: desktopDir });

const exe = join(desktopDir, "build", "bin", isWin ? "demo-discord.exe" : "demo-discord");
console.log(`\nDesktop app: ${exe}`);
