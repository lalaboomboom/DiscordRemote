import { test } from "node:test";
import assert from "node:assert/strict";
import { directoryChoices, resolveDirectoryChoice, type DirectoryChoiceContext } from "../apps/discord/directory-choices.js";
import { SessionError } from "../apps/discord/errors.js";

const linux: DirectoryChoiceContext = { guildId: "123456789012345678", hostId: "local", platform: "linux", recent: [], defaultCwd: "/default" };
const windows: DirectoryChoiceContext = { ...linux, hostId: "agent-0123456789abcdef", platform: "win32", defaultCwd: "D:\\Projects\\Demo" };

test("recent choices preserve order, deduplicate target paths and offer only four recent plus distinct default", () => {
  const context = { ...linux, recent: ["/projects/recent/", "/projects/recent", "/projects/second", "/projects/Third", "/projects/fourth", "/projects/ignored"] };
  const choices = directoryChoices({ ...context, query: "" });
  assert.deepEqual(choices.map(choice => choice.value), ["/projects/recent/", "/projects/second", "/projects/Third", "/projects/fourth", "/default"]);
  assert.ok(choices.slice(0, 4).every(choice => choice.name.startsWith("Recent: ")));
  assert.equal(choices[4].name, "Default: /default");
  assert.deepEqual(directoryChoices({ ...context, query: "THIRD" }).map(choice => choice.value), ["/projects/Third"]);
  assert.deepEqual(directoryChoices({ ...context, defaultCwd: "/projects/recent", query: "" }).map(choice => choice.value), choices.slice(0, 4).map(choice => choice.value));
  assert.deepEqual(directoryChoices({ ...linux, query: "" }), [{ name: "Default: /default", value: "/default" }]);
  assert.deepEqual(directoryChoices({ ...context, query: "ignored" }), []);
});

test("Windows dedup normalizes drive, separator and trailing slash but preserves directory case", () => {
  const context = { ...windows, recent: ["d:/Projects/Research/", "D:\\Projects\\Research", "D:\\Projects\\research", "C:\\Projects\\Research"], defaultCwd: "D:\\Projects\\Research" };
  assert.deepEqual(directoryChoices({ ...context, query: "RESEARCH" }).map(choice => choice.value), ["d:/Projects/Research/", "D:\\Projects\\research", "C:\\Projects\\Research"]);
  assert.deepEqual(directoryChoices({ ...windows, recent: ["/wrong/os", "relative", "D:\\valid"], query: "" }).map(choice => choice.value), ["D:\\valid", "D:\\Projects\\Demo"]);
});

test("Linux and native Windows long choices round-trip full paths using stable bounded references", () => {
  for (const context of [
    { ...linux, recent: [`/projects/${"a".repeat(140)}/result-folder`] },
    { ...windows, recent: [`D:\\Projects\\${" nghiên cứu".repeat(15)}\\result-folder`] },
  ]) {
    const first = directoryChoices({ ...context, query: "result-folder" });
    assert.equal(first.length, 1);
    assert.ok(first[0].name.length <= 100);
    assert.match(first[0].value, /^cwd-ref:[a-f0-9]{64}$/);
    assert.ok(first[0].value.length <= 100);
    assert.equal(resolveDirectoryChoice({ ...context, value: first[0].value }), context.recent[0]);
    assert.deepEqual(directoryChoices({ ...context, query: "result-folder" }), first);
    assert.ok(!first[0].value.includes("result-folder"));
  }
  const exactly100 = "/" + "a".repeat(99), over100 = "/" + "b".repeat(100);
  const context = { ...linux, recent: [exactly100, over100] };
  const choices = directoryChoices({ ...context, query: "" });
  assert.equal(choices[0].value, exactly100);
  assert.match(choices[1].value, /^cwd-ref:/);
  assert.equal(resolveDirectoryChoice({ ...context, value: choices[1].value }), over100);
});

test("long references reject changed guild, physical host, platform, stale candidates and malformed tokens", () => {
  const path = `/projects/${"private-folder-".repeat(12)}`;
  const context = { ...linux, recent: [path] };
  const token = directoryChoices({ ...context, query: "private" })[0].value;
  for (const changes of [
    { guildId: "223456789012345678" }, { hostId: "gpu-server" }, { platform: "win32" as const },
    { recent: [] }, { recent: [path + "/another"] },
  ]) assert.throws(() => resolveDirectoryChoice({ ...context, ...changes, value: token }), SessionError);
  for (const value of ["cwd-ref:", "cwd-ref:short", "cwd-ref:" + "0".repeat(64), token.toUpperCase().replace("CWD-REF:", "cwd-ref:")]) {
    assert.throws(() => resolveDirectoryChoice({ ...context, value }), SessionError);
  }
  // A folder still offered as the current category default is not stale.
  assert.equal(resolveDirectoryChoice({ ...context, recent: [], defaultCwd: path, value: token }), path);
});

test("omitted and manually typed paths stay unchanged rather than falling back or truncating", () => {
  for (const context of [linux, windows]) {
    assert.equal(resolveDirectoryChoice({ ...context, value: null }), null);
    const path = context.platform === "linux" ? `/new/${"a".repeat(180)}` : `D:\\New\\${"b".repeat(180)}`;
    assert.equal(resolveDirectoryChoice({ ...context, value: path }), path);
    // These values are deliberately left for the normal absolute-path validator.
    for (const value of ["relative/project", "", "/typed/folder/cwd-ref:literal"]) {
      assert.equal(resolveDirectoryChoice({ ...context, value }), value);
    }
  }
});
