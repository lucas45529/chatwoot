import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { snapshot, verifySnapshot } from "../scripts/snapshot-memory.mjs";

const temporaryRoots = [];
const realMemoryStore = process.env.MEMORY_TEST_SOURCE ?? path.join(os.homedir(), ".claude", "memory-mcp");
if (!fs.existsSync(path.join(realMemoryStore, "node_modules/better-sqlite3"))) {
  throw new Error(`MEMORY_TEST_SOURCE lacks node_modules/better-sqlite3: ${realMemoryStore}`);
}

function fixture({ malformed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-memory-"));
  temporaryRoots.push(root);
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, ".state"), { recursive: true });
  fs.mkdirSync(path.join(source, ".backup"));
  fs.mkdirSync(path.join(source, "dist"));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "fixture", type: "module" }));
  const lockMarker = path.join(root, "lock-marker");
  fs.writeFileSync(path.join(source, "dist/local-store.js"), "import fs from 'node:fs'; export function withStoreLock(operation) { fs.appendFileSync(process.env.MEMORY_TEST_LOCK_MARKER, 'locked\\n'); return operation(); }\n");
  process.env.MEMORY_TEST_LOCK_MARKER = lockMarker;
  const metadata = malformed
    ? '{"id":"broken","namespace":"fixture","source":"fixture"}\n{"id":\n'
    : '{"id":"one",\r"namespace":"fixture","source":"fixture","text":"one"}\n{"id":"two","namespace":"fixture","source":"fixture","text":"two"}\n';
  fs.writeFileSync(path.join(source, ".state/local-meta.jsonl"), metadata);
  fs.writeFileSync(path.join(source, ".state/local-vecs.f32"), Buffer.alloc(2 * 1024 * 4));
  fs.writeFileSync(path.join(source, ".state/local-tombstones.jsonl"), '{"id":"gone","deleted":true}\n');
  fs.writeFileSync(path.join(source, ".backup/.pending.jsonl"), '{"namespace":"fixture","id":"pending","chunk_text":"pending"}\n{"text":"legacy","title":"fixture","type":"note","tags":[]}\n');
  fs.writeFileSync(path.join(source, ".backup/fixture.jsonl"), '{"namespace":"fixture","id":"backup"}\n');
  fs.writeFileSync(path.join(source, ".backup/store-errors.jsonl"), "not copied\n");
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.symlinkSync(path.join(realMemoryStore, "node_modules/better-sqlite3"), path.join(source, "node_modules/better-sqlite3"), "dir");
  return { root, source, output: path.join(root, "snapshot"), lockMarker };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.MEMORY_TEST_LOCK_MARKER;
});

test("creates a locked primary snapshot, streams FTS, and verifies parity", async () => {
  const item = fixture();
  const result = await snapshot(item);
  assert.equal(result.rows, 2);
  assert.equal(fs.readFileSync(item.lockMarker, "utf8"), "locked\n");
  assert.equal(fs.existsSync(path.join(item.output, ".state/local.usearch")), false);
  assert.equal(fs.existsSync(path.join(item.output, ".backup/store-errors.jsonl")), false);
  assert.deepEqual(verifySnapshot(item.output, { source: item.source }).rows, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(item.output, "manifest.json"))).files.length, 6);
  assert.equal(fs.statSync(item.output).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(item.output, ".state/local-meta.jsonl")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(item.output, "manifest.json"))).primary.metadataUniqueRows, 2);
});

test("rejects malformed metadata before producing a trusted snapshot", async () => {
  const item = fixture({ malformed: true });
  await assert.rejects(() => snapshot(item), /invalid JSONL/);
});

test("rejects source/output containment and an existing destination", async () => {
  const item = fixture();
  await assert.rejects(() => snapshot({ source: item.source, output: path.join(item.source, "nested") }), /containment/);
  await assert.rejects(() => snapshot({ source: item.source, output: item.root }), /already exists/);
});

test("verification detects tampering and symlink/extra entries", async () => {
  const item = fixture();
  await snapshot(item);
  fs.appendFileSync(path.join(item.output, ".state/local-meta.jsonl"), " ");
  assert.throws(() => verifySnapshot(item.output), /tampered/);

  const second = fixture();
  await snapshot(second);
  fs.symlinkSync(path.join(second.output, ".state/local-meta.jsonl"), path.join(second.output, "extra-link"));
  assert.throws(() => verifySnapshot(second.output), /symlink|extra/);
});

test("verification rejects loosened snapshot permissions", async () => {
  const item = fixture();
  await snapshot(item);
  fs.chmodSync(path.join(item.output, ".state"), 0o755);
  assert.throws(() => verifySnapshot(item.output), /mode is not 700/);
});
