#!/usr/bin/env node

import { runCli } from "./cli.js";

runCli().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
