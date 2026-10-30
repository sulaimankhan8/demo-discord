// Builds the Android APK with Gradle and publishes it for the website's download button.
//
//   npm run apk          web build + cap sync + Gradle + copy into public/downloads
//   npm run apk:copy     only copy the last built APK into public/downloads
//
// The website serves public/downloads/demo-discord.apk and reads apk.json for the version.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const androidDir = join(root, "android");
const builtApk = join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const downloadsDir = join(root, "public", "downloads");
const copyOnly = process.argv.includes("--copy-only");

/** Gradle 8.14 needs JDK 21. Use JAVA_HOME if it is 21, else look for Android Studio's download. */
function findJdk21() {
  const fromEnv = process.env.JAVA_HOME;
  if (fromEnv && /21/.test(readRelease(fromEnv))) return fromEnv;
  const candidates = [join(homedir(), ".jdks"), join(homedir(), ".gradle", "jdks")];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const home = join(base, name);
      if (statSync(home).isDirectory() && /JAVA_VERSION="21/.test(readRelease(home))) return home;
    }
  }
  return null;
}

function readRelease(home) {
  try {
    return readFileSync(join(home, "release"), "utf8");
  } catch {
    return "";
  }
}

function gradleBuild() {
  const jdk = findJdk21();
  if (!jdk) {
    console.error("JDK 21 not found. Set JAVA_HOME to a JDK 21 (Android Studio: Settings → Gradle → Gradle JDK → 21).");
    process.exit(1);
  }
  console.log(`Building APK with JDK at ${jdk}`);
  const isWin = process.platform === "win32";
  // Full path: some Windows shells don't look in the current folder for commands.
  const gradlew = join(androidDir, isWin ? "gradlew.bat" : "gradlew");
  execFileSync(isWin ? `"${gradlew}"` : gradlew, ["assembleDebug"], {
    cwd: androidDir,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, JAVA_HOME: jdk },
  });
}

function publish() {
  if (!existsSync(builtApk)) {
    console.error(`No APK at ${builtApk}. Run \`npm run apk\` first.`);
    process.exit(1);
  }
  const gradle = readFileSync(join(androidDir, "app", "build.gradle"), "utf8");
  const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1] ?? "unknown";
  const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1] ?? 0);

  mkdirSync(downloadsDir, { recursive: true });
  const target = join(downloadsDir, "demo-discord.apk");
  copyFileSync(builtApk, target);
  const info = {
    file: "/downloads/demo-discord.apk",
    versionName,
    versionCode,
    sizeBytes: statSync(target).size,
    builtAt: statSync(builtApk).mtime.toISOString(),
    build: "debug",
  };
  writeFileSync(join(downloadsDir, "apk.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`Published v${versionName} (${(info.sizeBytes / 1048576).toFixed(1)} MB) to public/downloads/`);
}

if (!copyOnly) gradleBuild();
publish();
