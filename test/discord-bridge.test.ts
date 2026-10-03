import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorized, authorizedGuild, claimInteraction, configFromEnv, createManagedTmux, TmuxTerminal, formatOutput, redact, submitTmuxInput, terminalEnvironment, TMUX_INPUT_VERSION, TMUX_SUBMIT_GAP_MS, trustedDiscordUserIds, validateInput } from "../apps/discord/core.js";
import { ChannelSessionStore } from "../apps/discord/channel-sessions.js";
import { buildTerminalCommands } from "../apps/discord/command.js";
import { HostExecutor, hostForMachine, hostTargetConnection, loadHostTargets } from "../apps/discord/hosts.js";
import { machineDisplayName, sessionChoiceName, sessionDisplayName, sessionListLine, sessionReference, shortSessionId } from "../apps/discord/session-display.js";
import { CategoryBindingStore, ChannelBindingStore, GuildSetupStore } from "../apps/discord/topology.js";
import { attachmentDigest, attachmentPath, buildAttachmentPrompt, isTextAttachment, safeAttachmentName } from "../apps/discord/attachments.js";

const config = { token: "fixture-only", ownerId: "123456789012345678", guildId: "223456789012345678" };

test("Discord access is owner + guild scoped and optionally channel scoped", () => {
  assert.equal(authorized(config, config.ownerId, config.guildId, "a"), true);
  assert.equal(authorized(config, "other", config.guildId, "a"), false);
  assert.equal(authorized(config, config.ownerId, null, "a"), false);
  assert.equal(authorized(config, config.ownerId, "other", "a"), false);
  assert.equal(authorized({ ...config, channelId: "b" }, config.ownerId, config.guildId, "a"), false);
  assert.equal(authorizedGuild(config, config.ownerId, config.guildId), true);
  assert.equal(authorizedGuild(config, config.ownerId, "other"), false);
});

test("explicit trusted users can use the bot while guild/channel restrictions and enrollment owner remain", () => {
  const extra = "1023456789012345678";
  const configured = configFromEnv({ DISCORD_BOT_TOKEN:config.token, DISCORD_OWNER_ID:config.ownerId, DISCORD_GUILD_ID:config.guildId,
    DISCORD_CHANNEL_ID:"323456789012345678", DISCORD_ALLOWED_USER_IDS:` ${extra}, ${config.ownerId}, ${extra} ` });
  assert.equal(configured.ownerId, config.ownerId);
  assert.deepEqual(configured.allowedUserIds, [extra]);
  assert.deepEqual(trustedDiscordUserIds(configured), [config.ownerId, extra]);
  for (const user of [config.ownerId, extra]) {
    assert.equal(authorized(configured, user, config.guildId, configured.channelId!), true);
    assert.equal(authorized(configured, user, config.guildId, "423456789012345678"), false);
    assert.equal(authorized(configured, user, "523456789012345678", configured.channelId!), false);
    assert.equal(authorizedGuild(configured, user, config.guildId), true);
    assert.equal(authorizedGuild(configured, user, null), false);
  }
  for (const stranger of ["1023456789012345679", extra.slice(0,-1), `<@${extra}>`, "other"]) {
    assert.equal(authorizedGuild(configured, stranger, config.guildId), false);
    assert.equal(authorized(configured, stranger, config.guildId, configured.channelId!), false);
  }
  const original = configFromEnv({ DISCORD_BOT_TOKEN:config.token, DISCORD_OWNER_ID:config.ownerId, DISCORD_GUILD_ID:config.guildId });
  assert.deepEqual(trustedDiscordUserIds(original), [config.ownerId]);
  assert.equal(authorizedGuild(original, extra, config.guildId), false);
});

test("malformed or excessive trusted-user configuration fails closed without printing token or values", () => {
  const token = "private-fixture-token", valid = "1023456789012345678";
  const tooMany = Array.from({length:32},(_,index) => String(400000000000000000n+BigInt(index))).join(",");
  for (const allowed of ["other", `<@${valid}>`, `${valid},`, `,${valid}`, `${valid},,${valid}`, "1".repeat(16), "1".repeat(21), `${valid}\n${valid}`, tooMany, Array(34).fill(valid).join(",")]) {
    assert.throws(() => configFromEnv({ DISCORD_BOT_TOKEN:token, DISCORD_OWNER_ID:config.ownerId, DISCORD_GUILD_ID:config.guildId, DISCORD_ALLOWED_USER_IDS:allowed }), error =>
      error instanceof Error && !error.message.includes(token) && !error.message.includes(allowed));
  }
});

test("channel terminal selections persist independently and reset to demo safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-channel-selection-"));
  try {
    const file = join(dir, "channel-sessions.json");
    const first = "123456789012345678";
    const second = "223456789012345678";
    const session = `vsc-${"a".repeat(16)}-${"b".repeat(8)}`;
    const store = new ChannelSessionStore(file);
    assert.equal(store.get(first), undefined);
    store.set(first, session);
    store.set(second, "demo");
    const afterRestart = new ChannelSessionStore(file);
    assert.equal(afterRestart.get(first), session);
    assert.equal(afterRestart.get(second), "demo");
    afterRestart.set(first, "demo");
    assert.equal(new ChannelSessionStore(file).get(first), "demo");
    assert.equal(new ChannelSessionStore(file).get(second), "demo");
    assert.throws(() => afterRestart.set("bad-channel", session));
    assert.throws(() => afterRestart.set(first, "unknown-session"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only /terminal attach chooses a session; create-channel starts a default shell", () => {
  const commands = buildTerminalCommands().map(command => command.toJSON() as any);
  const byName = (name: string): any => commands.find(command => command.name === name);
  assert.deepEqual(commands.map(command => command.name), ["sessions", "status", "output", "send", "key", "interrupt", "run", "gpu", "notify", "setup", "machine", "terminal"]);
  assert.equal(commands.length, 12);
  assert.equal(byName("select"), undefined);
  assert.equal(byName("new"), undefined);
  for (const name of ["sessions", "status", "output", "send", "key", "interrupt", "run", "gpu", "notify", "setup", "machine"]) {
    assert.ok(!byName(name).options?.some((option: any) => option.name === "session"));
  }
  assert.equal(byName("send").options.find((option: any) => option.name === "text").required, true);
  assert.deepEqual(byName("key").options.find((option: any) => option.name === "key").choices.map((choice: any) => choice.value), ["enter", "ctrl-c", "escape", "tab", "up", "down", "left", "right", "shift-left"]);
  assert.equal(byName("key").options.find((option: any) => option.name === "key").choices.find((choice: any) => choice.value === "shift-left").name, "Shift + Left");
  assert.equal(byName("run").options.find((option: any) => option.name === "command").required, true);
  assert.deepEqual(byName("notify").options.map((option: any) => option.name), ["on", "off", "status"]);
  const notifyOn = byName("notify").options.find((option: any) => option.name === "on");
  assert.equal(notifyOn.options.find((option: any) => option.name === "thread").required, true);
  assert.equal(notifyOn.options.find((option: any) => option.name === "lines").min_value, 50);
  assert.equal(notifyOn.options.find((option: any) => option.name === "lines").max_value, 70);
  assert.equal(byName("setup").options.find((option: any) => option.name === "orchestrator").channel_types[0], 0);
  assert.deepEqual(byName("machine").options.map((option: any) => option.name), ["pair", "revoke", "add", "list", "bind", "remove"]);
  assert.deepEqual(byName("terminal").options.map((option: any) => option.name), ["attach", "create-channel", "stop", "close"]);
  const attach = byName("terminal").options.find((option: any) => option.name === "attach");
  assert.deepEqual(attach.options.map((option: any) => option.name), ["session", "category", "name"]);
  assert.equal(attach.options.find((option: any) => option.name === "session").required, true);
  assert.equal(attach.options.find((option: any) => option.name === "session").autocomplete, true);
  assert.equal(attach.options.find((option: any) => option.name === "category").required, true);
  assert.deepEqual(attach.options.find((option: any) => option.name === "category").channel_types, [4]);
  const createChannel = byName("terminal").options.find((option: any) => option.name === "create-channel");
  assert.deepEqual(createChannel.options.map((option: any) => option.name), ["category", "name", "cwd"]);
  assert.equal(createChannel.options.find((option: any) => option.name === "category").required, true);
  assert.deepEqual(createChannel.options.find((option: any) => option.name === "category").channel_types, [4]);
  assert.equal(createChannel.options.find((option: any) => option.name === "cwd").type, 3);
  assert.notEqual(createChannel.options.find((option: any) => option.name === "cwd").required, true);
  assert.equal(createChannel.options.find((option: any) => option.name === "cwd").max_length, 500);
  assert.equal(createChannel.options.find((option: any) => option.name === "cwd").autocomplete, true);
  assert.equal(byName("terminal").options.find((option: any) => option.name === "stop").options.find((option: any) => option.name === "confirm").required, true);
  assert.equal(byName("terminal").options.find((option: any) => option.name === "close").options.find((option: any) => option.name === "confirm").required, true);
});

test("guild topology stores are durable and keep terminal channels bound to categories", () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-topology-"));
  try {
    const guild = "123456789012345678";
    const category = "223456789012345678";
    const channel = "323456789012345678";
    const setup = new GuildSetupStore(join(dir, "guild.json"));
    setup.set({ guildId: guild, ownerId: "423456789012345678", orchestratorChannelId: "523456789012345678", version: 1, updatedAt: 10 });
    assert.equal(new GuildSetupStore(join(dir, "guild.json")).get(guild)?.orchestratorChannelId, "523456789012345678");
    const categories = new CategoryBindingStore(join(dir, "categories.json"));
    categories.set({ guildId: guild, categoryId: category, hostId: "gpu-server", defaultCwd: "/srv/projects/demo", createdAt: 10, updatedAt: 10 });
    assert.equal(categories.findByHost(guild, "gpu-server")?.categoryId, category);
    categories.set({ guildId: guild, categoryId: "423456789012345678", hostId: "gpu-server", label: "second-project", defaultCwd: "/srv/projects/other", createdAt: 11, updatedAt: 11 });
    assert.equal(categories.findByHostAndCwd(guild, "gpu-server", "/srv/projects/other")?.label, "second-project");
    assert.equal(categories.list(guild).length, 2);
    const channels = new ChannelBindingStore(join(dir, "channels.json"));
    channels.set({ guildId: guild, channelId: channel, categoryId: category, hostId: "gpu-server", cwd: "/srv/projects/demo", status: "ready", terminalId: "tmux-abcdef1234", createdAt: 10, updatedAt: 10 });
    assert.equal(new ChannelBindingStore(join(dir, "channels.json")).get(channel)?.terminalId, "tmux-abcdef1234");
    assert.throws(() => channels.set({ guildId: guild, channelId: channel, categoryId: category, hostId: "gpu-server", cwd: "relative", status: "ready", terminalId: "tmux-abcdef1234", createdAt: 10, updatedAt: 10 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session display identifies machine, folder and terminal while keeping IDs opaque", () => {
  const session = {
    id: "vsc-a1a1a1a1a1a1a1a1-11223344",
    label: "node",
    machine: "gpu-server",
    cwd: "/srv/projects/demo",
    provider: "vscode",
  };
  assert.equal(shortSessionId(session.id), "vsc-…11223344");
  assert.equal(sessionDisplayName(session), "gpu-server · /srv/projects/demo · node · VS Code");
  assert.equal(sessionReference(session), "gpu-server · /srv/projects/demo · node · VS Code [vsc-…11223344]");
  assert.match(sessionChoiceName(session), /^gpu-server · \/srv\/projects\/demo · node · VS Code · vsc-…11223344$/);
  assert.equal(sessionListLine(session, "shared"), "gpu-server · /srv/projects/demo · node · VS Code [vsc-…11223344] · shared");
  const long = sessionChoiceName({ ...session, machine: "machine-name-that-is-deliberately-long".repeat(4), cwd: "/a/very/long/project/path/that/keeps/going".repeat(4) });
  assert.ok(long.length <= 100);
  assert.ok(long.endsWith("vsc-…11223344"));
});

test("Remote-SSH authorities are shown as their configured host name", () => {
  const authority = "ssh-remote+7b22686f73744e616d65223a226770752d736572766572227d";
  assert.equal(machineDisplayName(authority), "gpu-server");
  assert.equal(machineDisplayName("workstation"), "workstation");
  assert.equal(machineDisplayName("ssh-remote+future-format"), "ssh-remote+future-format");
});

test("Discord configuration fails closed and errors do not contain token values", () => {
  assert.throws(() => configFromEnv({ DISCORD_BOT_TOKEN: "private-fixture-token" }), error =>
    error instanceof Error && error.message.includes("DISCORD_OWNER_ID") && !error.message.includes("private-fixture"));
  assert.throws(() => configFromEnv({ DISCORD_BOT_TOKEN: "" }));
});

test("duplicate and stale Discord interactions never replay, including after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-dedup-"));
  try {
    const id = "123456789012345678";
    assert.equal(claimInteraction(dir, id, 100_000, 100_100), true);
    assert.equal(claimInteraction(dir, id, 100_000, 100_100), false);
    assert.equal(claimInteraction(dir, "223456789012345678", 1, 100_100), false);
    assert.equal(claimInteraction(dir, "323456789012345678", 200_000, 100_100), false);
    assert.equal(claimInteraction(dir, "../../bad", 100_000, 100_100), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminal input is literal argv, pinned to one pane, with Enter explicit", async () => {
  const calls: string[][] = [];
  const terminal = new TmuxTerminal(async args => { calls.push(args); return "session=fixture-terminal pane=%7 pid=1234 dead=0 exit= program=bash"; }, "%7");
  await terminal.send("hello $(touch nope); C-c");
  assert.deepEqual(calls.filter(args => args[0] === "send-keys"), [
    ["send-keys", "-t", "%7", "-l", "--", "hello $(touch nope); C-c"],
    ["send-keys", "-t", "%7", "Enter"],
  ]);
  assert.equal(calls.filter(args => args[0] === "display-message").length, 2);
  assert.ok(calls[0].at(-1)!.includes(`inputProtocol=${TMUX_INPUT_VERSION}`));
  await terminal.pressKey("ctrl-c");
  assert.deepEqual(calls.at(-1), ["send-keys", "-t", "%7", "C-c"]);
  await terminal.pressKey("shift-left");
  assert.deepEqual(calls.at(-1), ["send-keys", "-t", "%7", "S-Left"]);
  assert.throws(() => new TmuxTerminal(async () => "", "other:0"));
  for (const input of ["a\nb", "\x03", "", "x".repeat(501)]) assert.throws(() => validateInput(input));
});

test("tmux submission waits for the paste burst, rechecks identity and sends one Enter", async () => {
  let clock = 1000, lastCharacterAt = 0, received = "", checks = 0;
  const calls: string[][] = [], waits: number[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "display-message") { checks++; return "session=original pane=%7 pid=1234 dead=0 exit= program=codex"; }
    if (args.includes("-l")) { received = args.at(-1)!; lastCharacterAt = clock; }
    else if (args.at(-1) === "Enter") {
      // This consumer models Codex's Enter suppression after a fast paste burst.
      assert.ok(clock - lastCharacterAt > 120);
      assert.equal(checks, 2);
      received = `submitted:${received}`;
    }
    return "";
  };
  await submitTmuxInput("Một prompt Codex", run, "=original:.%7", 3000,
    async ms => { waits.push(ms); clock += ms; }, () => clock);
  assert.deepEqual(waits, [TMUX_SUBMIT_GAP_MS]);
  assert.equal(received, "submitted:Một prompt Codex");
  assert.ok(calls.every(args => args[3] === "=original:.%7" || args[2] === "=original:.%7"));
  assert.equal(calls.filter(args => args.at(-1) === "Enter").length, 1);
});

test("tmux never submits text to a changed, closed or expired terminal", async () => {
  for (const outcome of ["pid", "session", "dead", "unavailable", "expired"]) {
    let clock = 1000, checks = 0;
    const writes: string[][] = [];
    const run = async (args: string[]) => {
      if (args[0] !== "display-message") { writes.push(args); return ""; }
      if (++checks === 1) return "session=original pane=%7 pid=1234 dead=0";
      if (outcome === "unavailable") throw new Error("no server running");
      return `session=${outcome === "session" ? "replacement" : "original"} pane=%7 pid=${outcome === "pid" ? 1235 : 1234} dead=${outcome === "dead" ? 1 : 0}`;
    };
    await assert.rejects(submitTmuxInput("one prompt", run, "=original:.%7", 3000,
      async ms => { clock += outcome === "expired" ? 2000 : ms; }, () => clock), /Text was delivered but Enter was not sent.*do not automatically retry/);
    assert.deepEqual(writes, [["send-keys", "-t", "=original:.%7", "-l", "--", "one prompt"]]);
  }
});

test("tmux rejects before input when unavailable or near expiry and never retries an ambiguous Enter", async () => {
  for (const unavailable of [false, true]) {
    const writes: string[][] = [];
    await assert.rejects(submitTmuxInput("hello", async args => {
      if (args[0] !== "display-message") writes.push(args);
      return "session=original pane=%7 pid=1234 dead=1";
    }, "%7", unavailable ? 3000 : 1000 + TMUX_SUBMIT_GAP_MS, async () => {}, () => 1000), /no input sent/);
    assert.deepEqual(writes, []);
  }
  const writes: string[][] = [];
  await assert.rejects(submitTmuxInput("hello", async args => {
    if (args[0] === "display-message") return "session=original pane=%7 pid=1234 dead=0";
    writes.push(args);
    if (args.at(-1) === "Enter") throw new Error("unknown transport outcome");
    return "";
  }, "%7", 3000, async () => {}, () => 1000), /unknown transport outcome/);
  assert.equal(writes.filter(args => args.at(-1) === "Enter").length, 1);
});

test("output is bounded, sanitized and redacted before truncation", () => {
  const output = formatOutput("password=hidden\n" + "abc".repeat(1000) + "\nactual-token\n```\n\x1b[31mred", ["actual-token"]);
  assert.ok(output.length < 2000);
  assert.ok(!output.includes("actual-token"));
  assert.ok(!output.includes("\x1b"));
  assert.equal((output.match(/```/g) ?? []).length, 2);
  assert.equal(redact("API_KEY='dummy secret'"), "API_KEY=[REDACTED]");
  assert.equal(redact("-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]");
});

test("tmux does not inherit Discord or other process credentials", () => {
  const env = terminalEnvironment({ DISCORD_BOT_TOKEN: "private", AWS_SECRET_ACCESS_KEY: "private", HOME: "/tmp", USER: "demo", PATH: "/unsafe" });
  assert.equal(env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
});

test("host diagnostics stay separate from the selected terminal and return exit facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-host-"));
  try {
    const targets = loadHostTargets(dir, {});
    assert.deepEqual(targets.map(target => target.id), ["local"]);
    assert.equal(hostForMachine(targets, "local").kind, "local");
    const result = await new HostExecutor(targets[0], dir).run(process.platform === "win32" ? "[Console]::Write('gpu-ok')" : "printf gpu-ok");
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "gpu-ok");
    assert.equal(result.stderr, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("host registry exposes named local/SSH profiles without storing passwords", () => {
  const dir = mkdtempSync(join(tmpdir(), "discord-host-registry-"));
  try {
    const registryDir = join(dir, ".remote-operator");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, "hosts.json"), JSON.stringify({ version: 1, hosts: [
      { id: "local", label: "Work PC", kind: "local", cwd: dir },
      { id: "gpu", label: "GPU server", kind: "ssh", host: "gpu.internal", user: "alice", port: 2202, cwd: "/datasets", passwordEnv: "GPU_PASSWORD" },
    ] }));
    const targets = loadHostTargets(dir, { GPU_PASSWORD: "fixture-password" });
    assert.deepEqual(targets.map(target => target.id), ["local", "gpu"]);
    assert.equal(targets[1].port, 2202);
    assert.equal(hostTargetConnection(targets[1]), "GPU server · SSH alice@gpu.internal:2202 · /datasets");
    assert.throws(() => {
      writeFileSync(join(registryDir, "hosts.json"), JSON.stringify({ hosts: [{ id: "gpu", label: "GPU server", kind: "ssh", host: "gpu.internal", user: "alice", port: 22, password: "secret" }] }));
      loadHostTargets(dir, {});
    }, /passwordEnv/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("text attachments become bounded file references instead of PTY-sized input", async () => {
  assert.equal(isTextAttachment({ name: "plan.md", url: "https://cdn.discordapp.com/attachments/a/b" }), true);
  assert.equal(isTextAttachment({ name: "weights.bin", url: "https://cdn.discordapp.com/attachments/a/b" }), false);
  assert.equal(safeAttachmentName("../../plan with spaces.md"), "plan_with_spaces.md");
  const data = Buffer.from("long plan\n", "utf8");
  const file = { originalName: "plan.md", relativePath: attachmentPath("123456789012345678", 0, "plan.md"), bytes: data.length, sha256: attachmentDigest(data) };
  const prompt = buildAttachmentPrompt("Follow this training plan", [file]);
  assert.ok(prompt.includes(file.relativePath));
  assert.ok(prompt.includes("Follow this training plan"));
  assert.ok(prompt.length <= 500);
  const many = [0, 1, 2, 3].map(index => ({ ...file, relativePath: attachmentPath("123456789012345678", index, `${"very-long-name-".repeat(8)}-${index}.md`) }));
  assert.ok(buildAttachmentPrompt("", many).length <= 500);
  const dir = mkdtempSync(join(tmpdir(), "discord-attachment-"));
  try {
    const targets = loadHostTargets(dir, {});
    const executor = new HostExecutor(targets[0], dir);
    await executor.writeFile(file.relativePath, data, dir);
    assert.equal(readFileSync(join(dir, file.relativePath), "utf8"), "long plan\n");
    await executor.removeFile(file.relativePath, dir);
    assert.equal(existsSync(join(dir, file.relativePath)), false);
    await assert.rejects(() => executor.writeFile("../escape.txt", data, dir), /invalid/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("managed tmux sessions use an opaque ID and named key transport", async () => {
  const calls: string[][] = [];
  const created = await createManagedTmux(async args => { calls.push(args); return "%9"; }, "bash", "/tmp/work", "local", "discord-bridge");
  assert.match(created.record.id, /^tmux-[a-f0-9]{10}$/);
  assert.equal(created.record.kind, "bash");
  await created.terminal.pressKey("enter");
  assert.deepEqual(calls[0].slice(0, 6), ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s"]);
  assert.deepEqual(calls.at(-1), ["send-keys", "-t", `=${created.record.tmuxSession}:.%9`, "Enter"]);
  await created.terminal.stop();
  assert.deepEqual(calls.at(-1), ["kill-session", "-t", `=${created.record.tmuxSession}`]);
});
