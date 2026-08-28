'use strict';

const fs = require('fs');
const path = require('path');

const stateDir = path.join(__dirname, '..', 'state');
const mdPath = path.join(stateDir, 'report.md');
const jsonPath = path.join(stateDir, 'report.json');

if (fs.existsSync(mdPath)) {
  console.log(fs.readFileSync(mdPath, 'utf8'));
} else if (fs.existsSync(jsonPath)) {
  console.log(fs.readFileSync(jsonPath, 'utf8'));
} else {
  console.log('No report yet — run `npm run monitor:once`');
}
