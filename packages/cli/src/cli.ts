#!/usr/bin/env node
// CLI entry. Use either `released <input>` or — when symlinked / installed via
// npm's bin field — `git released <input>` (git auto-discovers git-* on PATH).
//
// This file is intentionally just the executable shell: all logic lives in
// `app.ts`, which has no top-level side effects so it can be imported and
// tested without parsing argv or calling process.exit.

import { buildCli } from './app.js';

buildCli().parse();
