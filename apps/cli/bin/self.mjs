#!/usr/bin/env node
import { runCli } from "../dist/main.js";
await runCli(process.argv.slice(2));
