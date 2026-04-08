#!/usr/bin/env node
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "../src/index.ts");

execFileSync("npx", ["tsx", entry], { stdio: "inherit", cwd: resolve(__dirname, "..") });
