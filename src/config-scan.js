'use strict';

const fs = require('fs');
const path = require('path');
const delivery = require('./delivery');

const MAX_DEPTH = 6;
const MULTIPLIER_THRESHOLD = 2;

// Recursively finds every .opencode/opencode.json under a root (depth-capped).
function findConfigs(root, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (e.name === '.opencode' && e.isDirectory()) {
      const cfg = path.join(root, '.opencode', 'opencode.json');
      try {
        if (fs.statSync(cfg).isFile()) out.push(cfg);
      } catch (_) {}
    }
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      findConfigs(path.join(root, e.name), depth + 1, out);
    }
  }
}

// Scans project configs for agents pinned to opencode-go/<id> and flags pins
// that are materially more expensive than the hy3 baseline (report-only).
// Returns the list of pins found.
function runConfigScan(scanRoots, modelsMap, options) {
  options = options || {};
  const multThreshold = typeof options.multiplierThreshold === 'number' ? options.multiplierThreshold : MULTIPLIER_THRESHOLD;
  const roots = Array.isArray(scanRoots) ? scanRoots : [scanRoots];

  const configs = [];
  for (const r of roots) {
    if (typeof r === 'string') findConfigs(r, 0, configs);
  }

  // Baseline: hy3 output cost.
  let baseline = null;
  if (modelsMap && modelsMap.hy3 && modelsMap.hy3.cost) {
    baseline = modelsMap.hy3.cost.output;
  }

  const pins = [];
  for (const file of configs) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    const agents = (cfg && cfg.agent) || {};
    for (const name of Object.keys(agents)) {
      const m = agents[name] && agents[name].model;
      if (typeof m !== 'string') continue;
      const match = m.match(/^opencode-go\/(.+)$/);
      if (!match) continue;
      const id = match[1];
      const modelInfo = modelsMap && modelsMap[id];
      const outCost = modelInfo && modelInfo.cost ? modelInfo.cost.output : null;
      let multiplier = null;
      if (baseline && outCost) multiplier = outCost / baseline;
      const pin = { agent: name, file, model: id, outputCost: outCost, multiplier };
      pins.push(pin);
      if (multiplier != null && multiplier > multThreshold) {
        delivery.alert(
          'info',
          'Expensive agent pin',
          `agent ${name} in ${file} pinned to opencode-go/${id} (~${multiplier.toFixed(1)}x hy3 output cost)`
        );
      }
    }
  }
  return pins;
}

module.exports = { runConfigScan, findConfigs };
