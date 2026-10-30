// Removes out/downloads after the app's static build, so the phone app never
// carries a copy of the APK inside itself. Runs between `next build` and `cap sync`.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../out/downloads", import.meta.url));
rmSync(dir, { recursive: true, force: true });
console.log("Removed out/downloads from the app bundle.");
