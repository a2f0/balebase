import { spawnSync } from "node:child_process";
import { settings } from "../settings";
import { model } from "./codex";
import { evaluate } from "./evaluate";
import { judgeHandler } from "./http";

const auth = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
if (auth.status !== 0 || !`${auth.stdout}${auth.stderr}`.includes("ChatGPT")) {
  throw new Error("The local Judge requires Codex signed in using ChatGPT");
}
const version = spawnSync("codex", ["--version"], {
  encoding: "utf8",
}).stdout.trim();
const handle = judgeHandler({
  port: settings.judgePort,
  model,
  version,
  evaluate,
});
Bun.serve({
  hostname: "127.0.0.1",
  port: settings.judgePort,
  idleTimeout: 255,
  maxRequestBodySize: 10 * 1024 * 1024,
  fetch(request, server) {
    // Archive I/O and grading can together exceed Bun's connection idle limit.
    return handle(request, () => server.timeout(request, 0));
  },
});

console.log(
  `Codex Judge: http://127.0.0.1:${settings.judgePort} (${version}, ${model})`,
);
