const fs = require("fs");
const path = require("path");
const config = require("./config");
const defaultPairs = require("./pair");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultValue) {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJson(filePath, defaultValue = null) {
  try {
    ensureJsonFile(filePath, defaultValue ?? {});
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : defaultValue;
  } catch (error) {
    console.error(`readJson failed for ${filePath}:`, error.message);
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function appendJsonArray(filePath, item) {
  const arr = readJson(filePath, []);
  arr.push(item);
  writeJson(filePath, arr);
  return arr;
}

function nowIso() {
  return new Date().toISOString();
}

function uniqueUpper(values) {
  return [...new Set((values || []).map((v) => String(v).trim().toUpperCase()).filter(Boolean))];
}

function getAllowedPairs() {
  return uniqueUpper(defaultPairs);
}

function filterToAllowedPairs(pairs) {
  const allowed = new Set(getAllowedPairs());
  return uniqueUpper(pairs).filter((pair) => allowed.has(pair));
}

function ensureStorage() {
  ensureDir(config.storageDir || path.join(__dirname, "storage"));
  ensureDir(config.strategiesDir);
  ensureJsonFile(config.pairsPath, getAllowedPairs());
  ensureJsonFile(config.scoreStatePath, {});
  ensureJsonFile(config.activeSignalsPath, {});
  ensureJsonFile(config.dryRunPositionsPath, []);
  ensureJsonFile(config.closedTradesPath, []);
  ensureJsonFile(config.learnedPumpsPath, []);
  ensureJsonFile(config.strategiesIndexPath, []);
}

function getWatchedPairs() {
  const stored = readJson(config.pairsPath, getAllowedPairs()) || [];
  const filtered = filterToAllowedPairs(stored);
  return filtered.length ? filtered : getAllowedPairs();
}

function saveWatchedPairs(pairs) {
  const normalized = filterToAllowedPairs(pairs).sort();
  writeJson(config.pairsPath, normalized);
  return normalized;
}

module.exports = {
  ensureDir,
  ensureJsonFile,
  ensureStorage,
  readJson,
  writeJson,
  appendJsonArray,
  nowIso,
  uniqueUpper,
  getAllowedPairs,
  filterToAllowedPairs,
  getWatchedPairs,
  saveWatchedPairs,
};
