#!/usr/bin/env node
'use strict';

import { checkPackageAges } from './index';

const args = process.argv.slice(2);

const USAGE = 'Usage: minreleaseage <age_in_hours> [--dir <path>]\n';

if (args.filter((a) => a === '--dir').length > 1) {
  process.stderr.write('Error: --dir can only be specified once\n');
  process.stderr.write(USAGE);
  process.exit(1);
}

const dirIndex = args.indexOf('--dir');
let targetDir: string | undefined;
if (dirIndex !== -1) {
  targetDir = args[dirIndex + 1];
  if (!targetDir || targetDir.startsWith('-')) {
    process.stderr.write('Error: --dir requires a path argument\n');
    process.stderr.write(USAGE);
    process.exit(1);
  }
  args.splice(dirIndex, 2);
}

if (args.length === 0) {
  process.stderr.write(USAGE);
  process.exit(1);
}

if (args.length > 1 || args[0].startsWith('-')) {
  process.stderr.write(`Error: unexpected argument: ${args[args[0].startsWith('-') ? 0 : 1]}\n`);
  process.stderr.write(USAGE);
  process.exit(1);
}

const minAgeHours = parseFloat(args[0]);

if (isNaN(minAgeHours) || minAgeHours < 0) {
  process.stderr.write(`Error: <age_in_hours> must be a non-negative number, got: ${args[0]}\n`);
  process.exit(1);
}

checkPackageAges(minAgeHours, targetDir).catch((err: Error) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exit(1);
});
