#!/usr/bin/env node

/**
 * Make a point-in-time, portable copy of the local memory store.
 *
 * The source store is never rebuilt or modified.  The local-store lock covers
 * the lossless metadata/vector/tombstone copy; backup JSONL files are copied
 * with a stat-before/stat-after stability check because their writers do not
 * currently use that lock.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const VECTOR_DIMENSION = 1024;
const VECTOR_BYTES = VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT;
const COPY_RETRIES = 3;
const MANIFEST = "manifest.json";

function error(message) {
  return new Error(`snapshot-memory: ${message}`);
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs?.toString() ?? stat.mtimeMs].join(":");
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSourceOutputSafe(source, output) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw error("source must be a real directory");
  const sourceReal = fs.realpathSync(source);
  const outputAbsolute = path.resolve(output);
  if (fs.existsSync(outputAbsolute)) throw error("output already exists (create-only mode)");
  const parent = path.dirname(outputAbsolute);
  if (!fs.existsSync(parent)) throw error("output parent must already exist");
  const parentReal = fs.realpathSync(parent);
  const outputReal = path.join(parentReal, path.basename(outputAbsolute));
  if (isWithin(sourceReal, outputReal) || isWithin(outputReal, sourceReal)) {
    throw error("source/output containment is not allowed");
  }
  return { source: sourceReal, output: outputReal };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function ensureRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw error(`expected regular file: ${file}`);
  return stat;
}

function copyStableFile(source, destination, retries = COPY_RETRIES) {
  ensureRegularFile(source);
  const temporary = `${destination}.copying-${process.pid}`;
  let lastSignature = "";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try { fs.unlinkSync(temporary); } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    const before = ensureRegularFile(source);
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o600);
    const after = ensureRegularFile(source);
    lastSignature = statSignature(after);
    if (statSignature(before) !== lastSignature || fs.statSync(temporary).size !== after.size) continue;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    return { source: before, destination: fs.statSync(destination) };
  }
  try { fs.unlinkSync(temporary); } catch { /* best effort cleanup */ }
  throw error(`source changed while copying ${source} (${lastSignature})`);
}

function* readLines(file) {
  const descriptor = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      pending += decoder.write(buffer.subarray(0, bytes));
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    fs.closeSync(descriptor);
  }
}

function jsonlStats(file, kind) {
  let rows = 0;
  const keys = new Set();
  for (const line of readLines(file)) {
    if (!line.trim()) throw error(`blank JSONL record in ${kind}`);
    let value;
    try { value = JSON.parse(line); } catch { throw error(`invalid JSONL in ${kind}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw error(`non-object JSONL record in ${kind}`);
    if (kind === "metadata" && (typeof value.id !== "string" || typeof value.source !== "string")) {
      throw error("metadata record lacks id/source");
    }
    if (kind === "tombstones" && (typeof value.id !== "string" || typeof value.deleted !== "boolean")) {
      throw error("tombstone record lacks id/deleted");
    }
    if (kind === "backup" && (typeof value.namespace !== "string" || typeof value.id !== "string")) {
      throw error("backup record lacks namespace/id");
    }
    if (kind === "pending") {
      const chunkRecord = typeof value.namespace === "string" && typeof value.id === "string"
        && typeof value.chunk_text === "string";
      const legacyRecord = typeof value.text === "string" && typeof value.title === "string"
        && typeof value.type === "string";
      if (!chunkRecord && !legacyRecord) throw error("pending record has unsupported schema");
    }
    if (typeof value.id === "string") {
      const namespace = typeof value.namespace === "string"
        ? value.namespace
        : (kind === "metadata" && value.id.startsWith("live-memory/") ? value.id.split("/", 3)[1] : null);
      if (namespace) keys.add(`${namespace}\u0000${value.id}`);
    }
    rows += 1;
  }
  return { rows, uniqueRows: keys.size };
}

function vectorStats(file) {
  const stat = ensureRegularFile(file);
  if (stat.size % VECTOR_BYTES !== 0) throw error("vector file is not aligned to 1024 Float32 dimensions");
  return { rows: stat.size / VECTOR_BYTES, bytes: stat.size };
}

function sha256(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function relativeFile(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function backupFiles(backup) {
  if (!fs.existsSync(backup)) return [];
  const backupStat = fs.lstatSync(backup);
  if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) throw error(".backup must be a real directory");
  const files = [];
  for (const entry of fs.readdirSync(backup, { withFileTypes: true })) {
    if (!entry.name.endsWith(".jsonl") || entry.name === "store-errors.jsonl") continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw error(`unsupported backup JSONL entry: ${entry.name}`);
    files.push(entry.name);
  }
  return files.sort();
}

function sourceVersion(source) {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version ?? null; } catch { /* optional */ }
  const commit = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  return { version, commit: commit.status === 0 ? commit.stdout.trim() : null };
}

function nodeBinaries() {
  if (process.env.MEMORY_FTS_NODE) return [process.env.MEMORY_FTS_NODE];
  return [...new Set([process.execPath, "/opt/homebrew/bin/node", "/usr/local/bin/node"])]
    .filter((binary) => binary && fs.existsSync(binary));
}

function runNode(args, options) {
  let last;
  for (const binary of nodeBinaries()) {
    last = spawnSync(binary, args, options);
    if (last.status === 0) return last;
  }
  return last;
}

function childFailure(result) {
  if (result?.error?.code) return `error=${String(result.error.code).replace(/[^A-Z0-9_]/g, "_")}`;
  if (result?.signal) return `signal=${result.signal}`;
  try {
    const diagnostic = JSON.parse(result?.stderr?.trim() ?? "{}");
    const code = typeof diagnostic.code === "string" && /^(?:ERR|SQLITE)_[A-Z0-9_]+$/.test(diagnostic.code)
      ? diagnostic.code : null;
    const name = typeof diagnostic.name === "string" && /^[A-Za-z]+Error$/.test(diagnostic.name)
      ? diagnostic.name : null;
    if (code || name) return [name && `name=${name}`, code && `code=${code}`].filter(Boolean).join(",");
  } catch { /* child may have terminated before its sanitized diagnostic */ }
  return `status=${Number.isInteger(result?.status) ? result.status : "unknown"}`;
}

function rebuildFts(source, output, metadataRows) {
  const script = String.raw`
    import fs from "node:fs";
    import path from "node:path";
    import { StringDecoder } from "node:string_decoder";
    import { createRequire } from "node:module";
    async function main() {
    const require = createRequire(${JSON.stringify(pathToFileURL(path.join(source, "package.json")).href)});
    const Database = require("better-sqlite3");
    const state = path.join(process.env.MEMORY_ROOT, ".state");
    const meta = path.join(state, "local-meta.jsonl");
    const dbFile = path.join(state, "fts.db");
    const tmp = dbFile + ".tmp";
    for (const file of [tmp, tmp + "-wal", tmp + "-shm"]) if (fs.existsSync(file)) fs.rmSync(file);
    const db = new Database(tmp);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, source UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2');");
    const insert = db.prepare("INSERT INTO docs(id, source, title, body) VALUES (?,?,?,?)");
    const insertBatch = db.transaction((batch) => { for (const row of batch) insert.run(row.id, row.source, row.title, row.body); });
    function* readLines(file) {
      const descriptor = fs.openSync(file, "r");
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let pending = "";
      try {
        while (true) {
          const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (bytes === 0) break;
          pending += decoder.write(buffer.subarray(0, bytes));
          let newline;
          while ((newline = pending.indexOf("\n")) !== -1) {
            yield pending.slice(0, newline);
            pending = pending.slice(newline + 1);
          }
        }
        pending += decoder.end();
        if (pending) yield pending;
      } finally { fs.closeSync(descriptor); }
    }
    let batch = [], rows = 0;
    for (const line of readLines(meta)) {
      if (!line) continue;
      const value = JSON.parse(line);
      if (!value?.id) throw new Error("invalid metadata record");
      batch.push({ id: String(value.id), source: String(value.source ?? ""), title: String(value.title ?? ""), body: String(value.text ?? "") });
      rows += 1;
      if (batch.length >= 1000) { insertBatch(batch); batch = []; }
    }
    if (batch.length) insertBatch(batch);
    db.exec("INSERT INTO docs(docs) VALUES('optimize');");
    db.close();
    for (const file of [tmp + "-wal", tmp + "-shm", dbFile + "-wal", dbFile + "-shm"]) if (fs.existsSync(file)) fs.rmSync(file);
    fs.renameSync(tmp, dbFile);
    for (const file of [dbFile + "-wal", dbFile + "-shm"]) if (fs.existsSync(file)) fs.rmSync(file);
    fs.chmodSync(dbFile, 0o600);
    if (rows !== ${metadataRows}) throw new Error("FTS input row count changed during rebuild");
    process.stdout.write(JSON.stringify({ rows }));
    }
    main().catch((cause) => {
      const name = typeof cause?.name === "string" ? cause.name : "Error";
      const code = typeof cause?.code === "string" ? cause.code : "";
      process.stderr.write(JSON.stringify({ name, code }));
      process.exitCode = 1;
    });
  `;
  const result = runNode(["--input-type=module", "-e", script], {
    cwd: source,
    env: { ...process.env, MEMORY_ROOT: output },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw error(`streaming FTS rebuild failed (${childFailure(result)})`);
  try { return JSON.parse(result.stdout); } catch { throw error("streaming FTS rebuild returned no row count"); }
}

function fileManifest(root, sourceInfo) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw error(`snapshot contains symlink: ${relativeFile(root, full)}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        const relative = relativeFile(root, full);
        const item = { path: relative, size: stat.size, mode: stat.mode & 0o777, sha256: sha256(full) };
        if (relative === ".state/local-meta.jsonl") Object.assign(item, jsonlStats(full, "metadata"));
        else if (relative === ".state/local-vecs.f32") item.rows = vectorStats(full).rows;
        else if (relative === ".state/local-tombstones.jsonl") Object.assign(item, jsonlStats(full, "tombstones"));
        else if (relative.startsWith(".backup/") && relative.endsWith(".jsonl")) {
          const kind = path.posix.basename(relative).startsWith(".pending") ? "pending" : "backup";
          Object.assign(item, jsonlStats(full, kind));
        }
        files.push({ ...item, source: sourceInfo.get(relative) ?? null });
      } else throw error(`unsupported snapshot entry: ${relativeFile(root, full)}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function safeManifestPath(relative) {
  if (typeof relative !== "string" || !relative || path.posix.isAbsolute(relative)) throw error("manifest path is not relative");
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw error("manifest path traversal detected");
  }
  return normalized;
}

function walkSnapshot(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = relativeFile(root, full);
      if (entry.isSymbolicLink()) throw error(`snapshot symlink detected: ${relative}`);
      if (entry.isDirectory()) { entries.push({ path: relative, type: "directory" }); visit(full); }
      else if (entry.isFile()) entries.push({ path: relative, type: "file" });
      else throw error(`unsupported snapshot entry: ${relative}`);
    }
  };
  visit(root);
  return entries;
}

export function verifySnapshot(snapshot, { source = null } = {}) {
  const inputRoot = path.resolve(snapshot);
  const rootStat = fs.lstatSync(inputRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw error("snapshot root must be a real directory");
  if ((rootStat.mode & 0o777) !== 0o700) throw error("snapshot root mode is not 700");
  const root = fs.realpathSync(inputRoot);
  const manifestFile = path.join(root, MANIFEST);
  ensureRegularFile(manifestFile);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch { throw error("manifest is invalid JSON"); }
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.primary || !manifest.derived) {
    throw error("manifest schema is incomplete");
  }
  if (manifest.primary.vectorDimension !== VECTOR_DIMENSION
    || !Number.isSafeInteger(manifest.primary.metadataRows)
    || !Number.isSafeInteger(manifest.primary.vectorRows)
    || !Number.isSafeInteger(manifest.primary.metadataUniqueRows)
    || !Number.isSafeInteger(manifest.derived.ftsRows)) throw error("manifest counts are invalid");
  const expected = new Map();
  for (const item of manifest.files) {
    const relative = safeManifestPath(item.path);
    if (relative === MANIFEST || expected.has(relative)) throw error("manifest contains duplicate/invalid file path");
    expected.set(relative, item);
  }
  const actual = walkSnapshot(root);
  const actualFiles = new Set(actual.filter((entry) => entry.type === "file").map((entry) => entry.path));
  const actualDirs = new Set(actual.filter((entry) => entry.type === "directory").map((entry) => entry.path));
  if (!actualFiles.has(MANIFEST)) throw error("manifest is missing");
  for (const relative of expected.keys()) if (!actualFiles.has(relative)) throw error(`snapshot file missing: ${relative}`);
  for (const relative of actualFiles) if (relative !== MANIFEST && !expected.has(relative)) throw error(`extra snapshot file: ${relative}`);
  for (const relative of actualDirs) if (relative !== ".state" && relative !== ".backup") throw error(`extra snapshot directory: ${relative}`);
  for (const directory of [".state", ".backup"]) {
    const directoryPath = path.join(root, directory);
    if (!fs.existsSync(directoryPath) || (fs.statSync(directoryPath).mode & 0o777) !== 0o700) {
      throw error(`snapshot directory mode is not 700: ${directory}`);
    }
  }
  if ((fs.statSync(manifestFile).mode & 0o777) !== 0o600) throw error("manifest mode is not 600");
  for (const [relative, item] of expected) {
    const file = path.join(root, relative);
    const stat = ensureRegularFile(file);
    if ((stat.mode & 0o777) !== 0o600) throw error(`snapshot file mode is not 600: ${relative}`);
    if (stat.size !== item.size || sha256(file) !== item.sha256) throw error(`snapshot file tampered: ${relative}`);
  }
  const meta = expected.get(".state/local-meta.jsonl");
  const vectors = expected.get(".state/local-vecs.f32");
  if (!meta || !vectors) throw error("primary metadata/vector files are missing");
  const metadataStats = jsonlStats(path.join(root, meta.path), "metadata");
  const metadataRows = metadataStats.rows;
  const vectorRows = vectorStats(path.join(root, vectors.path)).rows;
  if (metadataRows !== vectorRows || metadataRows !== manifest.primary.metadataRows
    || metadataStats.uniqueRows !== manifest.primary.metadataUniqueRows
    || meta.uniqueRows !== metadataStats.uniqueRows) throw error("metadata/vector parity failed");
  const fts = expected.get(".state/fts.db");
  if (!fts || manifest.derived?.ftsRows !== metadataRows) throw error("FTS parity manifest failed");
  if (source) {
    const ftsPath = path.join(root, ".state/fts.db");
    const sidecars = [`${ftsPath}-wal`, `${ftsPath}-shm`];
    const hadSidecar = sidecars.map((file) => fs.existsSync(file));
    const script = `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(pathToFileURL(path.join(source, "package.json")).href)}); const db = require("better-sqlite3")(${JSON.stringify(ftsPath)}, { readonly: true, fileMustExist: true }); process.stdout.write(String(db.prepare("SELECT count(*) AS n FROM docs").get().n)); db.close();`;
    const result = runNode(["--input-type=module", "-e", script], { cwd: source, encoding: "utf8", maxBuffer: 1024 * 1024 });
    for (const [index, file] of sidecars.entries()) if (!hadSidecar[index] && fs.existsSync(file)) fs.rmSync(file);
    if (result.status !== 0 || Number(result.stdout) !== metadataRows) throw error("FTS row count parity failed");
  }
  return { rows: metadataRows, files: expected.size, ftsRows: manifest.derived.ftsRows };
}

function writeManifest({ source, output, sourceInfo, metadataStats, vectors, fts }) {
  const files = fileManifest(output, sourceInfo);
  const manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    sourceVersion: sourceVersion(source),
    primary: {
      metadataRows: metadataStats.rows, metadataUniqueRows: metadataStats.uniqueRows,
      vectorRows: vectors.rows, vectorDimension: VECTOR_DIMENSION,
    },
    derived: { ftsRows: fts.rows, ann: "absent; destination must use brute-force fallback until rebuilt" },
    files,
  };
  const manifestPath = path.join(output, MANIFEST);
  const manifestTmp = path.join(output, `${MANIFEST}.tmp-${process.pid}`);
  fs.writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.chmodSync(manifestTmp, 0o600);
  fs.renameSync(manifestTmp, manifestPath);
  fs.chmodSync(manifestPath, 0o600);
  try {
    return verifySnapshot(output, { source });
  } catch (cause) {
    // A failed verification must never leave a file that looks trusted.
    try { fs.unlinkSync(manifestPath); } catch { /* best effort cleanup */ }
    throw cause;
  }
}

export async function snapshot({ source, output }) {
  if (!source || !output) throw error("--source and --output are required");
  const safe = assertSourceOutputSafe(path.resolve(source), path.resolve(output));
  ensureDirectory(safe.output);
  const state = path.join(safe.output, ".state");
  ensureDirectory(state);
  const backup = path.join(safe.output, ".backup");
  const sourceState = path.join(safe.source, ".state");
  const sourceBackup = path.join(safe.source, ".backup");
  const sourceInfo = new Map();
  const localStoreUrl = pathToFileURL(path.join(safe.source, "dist/local-store.js")).href;
  if (!fs.existsSync(path.join(safe.source, "dist/local-store.js"))) throw error("source dist/local-store.js is missing");
  const previousRoot = process.env.MEMORY_ROOT;
  process.env.MEMORY_ROOT = safe.source;
  try {
    const localStore = await import(localStoreUrl);
    if (typeof localStore.withStoreLock !== "function") throw error("source local-store does not export withStoreLock");
    localStore.withStoreLock(() => {
      const meta = copyStableFile(path.join(sourceState, "local-meta.jsonl"), path.join(state, "local-meta.jsonl"));
      const vectors = copyStableFile(path.join(sourceState, "local-vecs.f32"), path.join(state, "local-vecs.f32"));
      sourceInfo.set(".state/local-meta.jsonl", { size: meta.source.size, mtimeMs: meta.source.mtimeMs });
      sourceInfo.set(".state/local-vecs.f32", { size: vectors.source.size, mtimeMs: vectors.source.mtimeMs });
      const tombstones = path.join(sourceState, "local-tombstones.jsonl");
      if (fs.existsSync(tombstones)) {
        const copied = copyStableFile(tombstones, path.join(state, "local-tombstones.jsonl"));
        sourceInfo.set(".state/local-tombstones.jsonl", { size: copied.source.size, mtimeMs: copied.source.mtimeMs });
      }
    });
  } finally {
    if (previousRoot === undefined) delete process.env.MEMORY_ROOT;
    else process.env.MEMORY_ROOT = previousRoot;
  }
  const metadataStats = jsonlStats(path.join(state, "local-meta.jsonl"), "metadata");
  const metadataRows = metadataStats.rows;
  const vectors = vectorStats(path.join(state, "local-vecs.f32"));
  if (metadataRows !== vectors.rows) throw error("metadata/vector parity failed");
  if (fs.existsSync(path.join(state, "local-tombstones.jsonl"))) jsonlStats(path.join(state, "local-tombstones.jsonl"), "tombstones");
  ensureDirectory(backup);
  const backupNames = backupFiles(sourceBackup);
  for (const name of backupNames) {
    const copied = copyStableFile(path.join(sourceBackup, name), path.join(backup, name));
    sourceInfo.set(`.backup/${name}`, { size: copied.source.size, mtimeMs: copied.source.mtimeMs });
    jsonlStats(path.join(backup, name), name.startsWith(".pending") ? "pending" : "backup");
  }
  if (JSON.stringify(backupNames) !== JSON.stringify(backupFiles(sourceBackup))) throw error(".backup file list changed during snapshot");
  const fts = rebuildFts(safe.source, safe.output, metadataRows);
  return writeManifest({ source: safe.source, output: safe.output, sourceInfo, metadataStats, vectors, fts });
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

async function main(args) {
  if (args[0] === "verify" || args.includes("--verify")) {
    const snapshotPath = flag(args, "--snapshot") ?? flag(args, "--output") ?? (args[0] === "verify" ? args[1] : null);
    if (!snapshotPath) throw error("verify requires --snapshot");
    const result = verifySnapshot(snapshotPath, { source: flag(args, "--source") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = await snapshot({ source: flag(args, "--source"), output: flag(args, "--output") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : "snapshot failed"}\n`);
    process.exitCode = 1;
  });
}
