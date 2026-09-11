import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const command = process.argv.slice(2);

if (!command.length) {
  console.error("A Node command is required.");
  process.exit(1);
}

const envFiles = ["--env-file=.env.example"];
if (existsSync(".env.local")) envFiles.push("--env-file=.env.local");

const child = spawn(process.execPath, [...envFiles, ...command], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
