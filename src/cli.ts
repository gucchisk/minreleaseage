#!/usr/bin/env node
'use strict';

import { checkPackageAges } from './index';

const args = process.argv.slice(2);

if (args.length === 0) {
  process.stderr.write('Usage: minreleaseage <age_in_hours>\n');
  process.exit(1);
}

const minAgeHours = parseFloat(args[0]);

if (isNaN(minAgeHours) || minAgeHours < 0) {
  process.stderr.write(`Error: <age_in_hours> must be a non-negative number, got: ${args[0]}\n`);
  process.exit(1);
}

checkPackageAges(minAgeHours).catch((err: Error) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exit(1);
});
