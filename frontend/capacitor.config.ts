import type { CapacitorConfig } from "@capacitor/cli";
import { existsSync, readFileSync } from "node:fs";

// Reads .env.capacitor (the app build's settings; see .env.capacitor.example).
function readAppEnv(): Record<string, string> {
  if (!existsSync(".env.capacitor")) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.capacitor", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Development only: lets the app talk to a plain-http backend on your network
// (e.g. http://192.168.1.2:4000). Keep it off for release builds and use https.
const allowHttp = readAppEnv().CAP_ALLOW_HTTP === "true";

const config: CapacitorConfig = {
  appId: "com.demodiscord.app",
  appName: "Demo Discord",
  webDir: "out",
  ...(allowHttp && {
    server: { androidScheme: "http", cleartext: true },
  }),
};

export default config;
