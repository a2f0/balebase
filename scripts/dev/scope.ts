import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { benchmark } from "./scope/benchmark";
import { calibrate } from "./scope/calibrate";
import { register } from "./scope/register";
import { regrade } from "./scope/regrade";
import { settings } from "./scope/settings";

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "register":
    if (args.length > 1) throw new Error("Usage: scope register [git-ref]");
    await register(args[0] ?? "HEAD");
    break;
  case "calibrate":
    if (args.length) throw new Error("Usage: scope calibrate");
    await calibrate();
    break;
  case "benchmark":
  case "smoke":
    if (args.length > (command === "smoke" ? 0 : 1))
      throw new Error("Usage: scope benchmark [count] or scope smoke");
    await benchmark(
      command === "smoke" ? "smoke" : "agent-friendliness",
      Number(args[0] ?? 1),
    );
    break;
  case "regrade":
    if (args.length !== 1 || !args[0])
      throw new Error("Usage: scope regrade <receipt.json>");
    await regrade(args[0]);
    break;
  case "judge":
    if (args.length) throw new Error("Usage: scope judge");
    await import("./scope/judge/server");
    break;
  case "portal": {
    if (args.length) throw new Error("Usage: scope portal");
    const result = spawnSync(
      "pnpm",
      [
        "--dir",
        settings.sourceDir,
        "--filter",
        "portal",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(settings.portalPort),
        "--strictPort",
      ],
      {
        cwd: settings.sourceDir,
        env: {
          ...process.env,
          VITE_API_PROXY_TARGET: settings.apiUrl,
          VITE_AUTH_ENABLED_LOCAL: "false",
        },
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    break;
  }
  default:
    throw new Error(
      `Unknown assessment command: ${command}. See ${join("docs", "scope.md")}.`,
    );
}
