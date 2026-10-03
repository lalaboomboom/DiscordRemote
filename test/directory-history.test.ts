import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryHistoryStore } from "../apps/discord/directory-history.js";
import { SessionError } from "../apps/discord/errors.js";
import { HostPlatform } from "../apps/discord/platform.js";

const guildId = "700000000000000001";
const secondGuild = "700000000000000002";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "directory-history-"));
  const file = join(directory, "state", "directory-history.json");
  let now = 1000;
  const store = new DirectoryHistoryStore(file, () => now);
  return { directory, file, store, tick: () => ++now,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("initialization creates a durable empty marker and leaves existing valid snapshots untouched", () => {
  const f = fixture();
  try {
    f.store.initialize();
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { version: 1, items: [] });
    const empty = readFileSync(f.file, "utf8");
    const initialInode = statSync(f.file).ino;
    const restarted = new DirectoryHistoryStore(f.file, () => { throw new Error("Initialization must not record a use"); });
    restarted.initialize();
    assert.equal(readFileSync(f.file, "utf8"), empty);
    assert.equal(statSync(f.file).ino, initialInode);
    assert.deepEqual(restarted.list(guildId, "local", "linux"), []);
    if (process.platform !== "win32") assert.equal(statSync(f.file).mode & 0o777, 0o600);
    f.store.record(guildId, "local", "/existing", "linux");
    const saved = readFileSync(f.file, "utf8");
    const recordedInode = statSync(f.file).ino;
    restarted.initialize();
    assert.equal(readFileSync(f.file, "utf8"), saved);
    assert.equal(statSync(f.file).ino, recordedInode);
    assert.deepEqual(restarted.list(guildId, "local", "linux"), ["/existing"]);
  } finally { f.cleanup(); }
});

test("four recent directories survive restart and reuse bumps recency without duplicate suggestions", () => {
  const f = fixture();
  try {
    assert.equal(f.store.file, f.file);
    assert.deepEqual(f.store.list(guildId, "local", "linux"), []);
    assert.equal(existsSync(f.file), false);
    for (let index = 1; index <= 5; index++) {
      f.tick();
      f.store.record(guildId, "local", `/projects/${index}`, "linux");
    }
    assert.deepEqual(new DirectoryHistoryStore(f.file).list(guildId, "local", "linux"),
      ["/projects/5", "/projects/4", "/projects/3", "/projects/2"]);
    // Equal/rolled-back clocks still put a successful use at the front.
    f.store.record(guildId, "local", "/projects/3/./", "linux");
    assert.deepEqual(f.store.list(guildId, "local", "linux"),
      ["/projects/3/./", "/projects/5", "/projects/4", "/projects/2"]);
    new DirectoryHistoryStore(f.file, () => 1).record(guildId, "local", "/projects/2", "linux");
    assert.deepEqual(f.store.list(guildId, "local", "linux"),
      ["/projects/2", "/projects/3/./", "/projects/5", "/projects/4"]);
  } finally { f.cleanup(); }
});

test("suggestions never cross guild, physical host or current target OS", () => {
  const f = fixture();
  try {
    f.store.record(guildId, "local", "/coordinator", "linux");
    f.store.record(guildId, "gpu", "/training", "linux");
    f.store.record(secondGuild, "local", "/private-other-guild", "linux");
    f.store.record(guildId, "local", "D:\\Windows", "win32");
    assert.deepEqual(f.store.list(guildId, "local", "linux"), ["/coordinator"]);
    assert.deepEqual(f.store.list(guildId, "local", "win32"), ["D:\\Windows"]);
    assert.deepEqual(f.store.list(guildId, "gpu", "linux"), ["/training"]);
    assert.deepEqual(f.store.list(secondGuild, "local", "linux"), ["/private-other-guild"]);
    assert.deepEqual(f.store.list(guildId, "unknown", "linux"), []);
    // A changed host OS does not preserve an unbounded old-platform history.
    for (let index = 1; index <= 4; index++) f.store.record(guildId, "local", `D:\\Windows${index}`, "win32");
    assert.deepEqual(f.store.list(guildId, "local", "linux"), []);
    assert.equal(f.store.list(guildId, "local", "win32").length, 4);
  } finally { f.cleanup(); }
});

test("Windows comparison normalizes drive and separators while preserving folder case and valid roots", () => {
  const f = fixture();
  try {
    f.store.record(guildId, "msi", "D:\\Project", "win32");
    f.store.record(guildId, "msi", "d:/Project/", "win32");
    assert.deepEqual(f.store.list(guildId, "msi", "win32"), ["d:/Project/"]);
    f.store.record(guildId, "msi", "D:\\project", "win32");
    assert.deepEqual(f.store.list(guildId, "msi", "win32"), ["D:\\project", "d:/Project/"]);
    f.store.record(guildId, "msi", "D:\\", "win32");
    f.store.record(guildId, "msi", "d:/", "win32");
    f.store.record(guildId, "msi", "\\\\server\\Share\\Project", "win32");
    assert.deepEqual(f.store.list(guildId, "msi", "win32"),
      ["\\\\server\\Share\\Project", "d:/", "D:\\project", "d:/Project/"]);
  } finally { f.cleanup(); }
});

test("invalid arguments cannot create or change the saved history", () => {
  const f = fixture();
  try {
    const invalid = [
      ["not-a-guild", "local", "/project", "linux"],
      [guildId, "host/name", "/project", "linux"],
      [guildId, "", "/project", "linux"],
      [guildId, "x".repeat(81), "/project", "linux"],
      [guildId, "local", "relative", "linux"],
      [guildId, "local", "D:\\Project", "linux"],
      [guildId, "msi", "/project", "win32"],
      [guildId, "msi", "D:relative", "win32"],
      [guildId, "msi", "\\\\?\\D:\\Project", "win32"],
      [guildId, "local", "/project\nsecret", "linux"],
      [guildId, "local", `/${"x".repeat(500)}`, "linux"],
      [guildId, "local", "/project", "darwin"],
    ];
    for (const [guild, host, cwd, platform] of invalid) {
      assert.throws(() => f.store.record(guild, host, cwd, platform as HostPlatform), SessionError);
      assert.equal(existsSync(f.file), false);
    }
    assert.throws(() => f.store.list("invalid", "local", "linux"), SessionError);
    f.store.record(guildId, "local", "/valid", "linux");
    const saved = readFileSync(f.file, "utf8");
    assert.throws(() => f.store.record(guildId, "local", "relative", "linux"), SessionError);
    assert.equal(readFileSync(f.file, "utf8"), saved);
    for (const now of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new DirectoryHistoryStore(f.file, () => now).record(guildId, "local", "/next", "linux"), SessionError);
      assert.equal(readFileSync(f.file, "utf8"), saved);
    }
  } finally { f.cleanup(); }
});

test("malformed, unsupported and duplicated saved data fails closed without overwriting it", () => {
  const f = fixture();
  try {
    f.store.record(guildId, "local", "/valid", "linux");
    const item = { guildId, hostId: "local", cwd: "/valid", platform: "linux", updatedAt: 1000 };
    const documents: unknown[] = [
      null, [], {}, { version: 2, items: [] }, { version: 1, items: "bad" },
      { version: 1, items: [], token: "private-token" },
      { version: 1, items: [{ ...item, password: "private-password" }] },
      { version: 1, items: [{ ...item, guildId: "invalid" }] },
      { version: 1, items: [{ ...item, hostId: "host/name" }] },
      { version: 1, items: [{ ...item, cwd: "relative" }] },
      { version: 1, items: [{ ...item, platform: "win32" }] },
      { version: 1, items: [{ ...item, updatedAt: "1000" }] },
      { version: 1, items: [{ ...item, updatedAt: -1 }] },
      { version: 1, items: [item, { ...item, cwd: "/valid/./" }] },
      { version: 1, items: Array.from({ length: 5 }, (_, index) => ({ ...item, cwd: `/project/${index}` })) },
      { version: 1, items: Array.from({ length: 1025 }, (_, index) => ({ ...item, hostId: `host-${index}` })) },
    ];
    for (const saved of ["not json", ...documents.map(value => JSON.stringify(value))]) {
      writeFileSync(f.file, saved);
      assert.throws(() => f.store.initialize(), SessionError);
      assert.throws(() => f.store.list(guildId, "local", "linux"), SessionError);
      assert.throws(() => f.store.record(guildId, "local", "/next", "linux"), SessionError);
      assert.equal(readFileSync(f.file, "utf8"), saved);
    }
    writeFileSync(f.file, " ".repeat(4 * 1024 * 1024 + 1));
    assert.throws(() => f.store.list(guildId, "local", "linux"), SessionError);
    assert.throws(() => f.store.record(guildId, "local", "/next", "linux"), SessionError);
    assert.equal(statSync(f.file).size, 4 * 1024 * 1024 + 1);
  } finally { f.cleanup(); }
});

test("the global bound evicts the oldest independent host without mixing scopes", () => {
  const f = fixture();
  try {
    f.store.record(guildId, "local", "/initial", "linux");
    const items = Array.from({ length: 1024 }, (_, index) => ({ guildId, hostId: `host-${index}`,
      cwd: `/project/${index}`, platform: "linux", updatedAt: index + 1 }));
    writeFileSync(f.file, JSON.stringify({ version: 1, items }));
    f.store.record(secondGuild, "local", "/newest", "linux");
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal(saved.items.length, 1024);
    assert.deepEqual(f.store.list(guildId, "host-0", "linux"), []);
    assert.deepEqual(f.store.list(guildId, "host-1", "linux"), ["/project/1"]);
    assert.deepEqual(f.store.list(secondGuild, "local", "linux"), ["/newest"]);
    assert.deepEqual(f.store.list(guildId, "local", "linux"), []);
  } finally { f.cleanup(); }
});

test("atomic private snapshots contain only directory metadata and leave no temporary files", () => {
  const f = fixture();
  try {
    f.store.record(guildId, "local", "/first", "linux");
    f.store.record(guildId, "local", "/second", "linux");
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["items", "version"]);
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.items.map((item: object) => Object.keys(item).sort()),
      Array(2).fill(["cwd", "guildId", "hostId", "platform", "updatedAt"]));
    assert.deepEqual(readdirSync(join(f.directory, "state")), ["directory-history.json"]);
    if (process.platform !== "win32") {
      assert.equal(statSync(f.file).mode & 0o777, 0o600);
      assert.equal(statSync(join(f.directory, "state")).mode & 0o777, 0o700);
    }
    assert.deepEqual(new DirectoryHistoryStore(f.file).list(guildId, "local", "linux"), ["/second", "/first"]);
  } finally { f.cleanup(); }
});

test("nonregular history and failed atomic replacement preserve existing local data", () => {
  const f = fixture();
  try {
    const directoryStore = new DirectoryHistoryStore(f.directory);
    assert.throws(() => directoryStore.initialize(), SessionError);
    assert.throws(() => directoryStore.list(guildId, "local", "linux"), SessionError);
    assert.throws(() => directoryStore.record(guildId, "local", "/valid", "linux"), SessionError);
    f.store.record(guildId, "local", "/valid", "linux");
    const saved = readFileSync(f.file, "utf8");
    if (process.platform !== "win32") {
      const link = join(f.directory, "history-link.json");
      symlinkSync(f.file, link);
      const linkedStore = new DirectoryHistoryStore(link);
      assert.throws(() => linkedStore.initialize(), SessionError);
      assert.throws(() => linkedStore.record(guildId, "local", "/next", "linux"), SessionError);
      assert.equal(readFileSync(f.file, "utf8"), saved);
    }
    const blocked = new DirectoryHistoryStore(join(f.file, "child.json"));
    assert.throws(() => blocked.record(guildId, "local", "/valid", "linux"), SessionError);
    assert.equal(readFileSync(f.file, "utf8"), saved);
    assert.deepEqual(readdirSync(join(f.directory, "state")), ["directory-history.json"]);
  } finally { f.cleanup(); }
});
