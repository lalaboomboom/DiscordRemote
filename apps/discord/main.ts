import {
  ApplicationCommandType,
  CategoryChannel,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  audit,
  authorized,
  authorizedGuild,
  claimInteraction,
  configFromEnv,
  createManagedTmux,
  formatOutput,
  ManagedKind,
  ManagedTmuxTerminal,
  redact,
  TerminalControl,
  TerminalKey,
  tmuxRunner,
  trustedDiscordUserIds,
  validateInput,
} from "./core.js";
import { SessionError } from "./errors.js";
import { ChannelSessionStore } from "./channel-sessions.js";
import { BoundTerminalChannelContext, isBoundTerminalChannel, requireBoundTerminalId } from "./channel-routing.js";
import { buildTerminalCommands } from "./command.js";
import { ManagedSessionStore } from "./managed-sessions.js";
import { formatHostResult, HostExecutor, hostPlatform, hostTargetConnection, hostTmuxRunner, loadHostTargets } from "./hosts.js";
import { configuredHostById, probeTmux } from "./host-probe.js";
import { HostPlatform, requireWorkingDirectory, sameWorkingDirectory } from "./platform.js";
import { ensurePtySupervisor, PtyTerminal } from "./pty-client.js";
import { ManagedTerminal } from "./pty-protocol.js";
import { isStoppedBinding, terminalLifecycle } from "./terminal-lifecycle.js";
import { ActionQueue } from "./action-queue.js";
import { fitDiscordMessage } from "./messages.js";
import { AgentHub, coordinatorUrl } from "./agent-hub.js";
import type { AgentPresence } from "./agent-hub.js";
import { AgentHostExecutor, AgentTerminal } from "./agent-client.js";
import { RemoteVscodeRegistry, RemoteVscodeTerminal } from "./remote-vscode.js";
import { resolveAttachmentTarget, validateAttachmentTarget } from "./attachment-target.js";
import { boundTerminalDirectory, terminalProvisionDirectory } from "./terminal-directory.js";
import { createTerminalChannel } from "./terminal-channel-create.js";
import { DirectoryHistoryStore } from "./directory-history.js";
import { directoryChoices, resolveDirectoryChoice } from "./directory-choices.js";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { CodexNotifications, NotificationStore, NotificationTarget } from "./notifications.js";
import { sessionChoiceName, sessionDisplayName, sessionListLine, sessionReference } from "./session-display.js";
import { VscodeTerminal, vscodeInventory, vscodeSessions } from "./vscode.js";
import {
  CategoryBindingRecord,
  CategoryBindingStore,
  ChannelBindingRecord,
  ChannelBindingStore,
  channelDisplayName,
  categoryDisplayName,
  GuildSetupStore,
  validateWorkingDirectory,
} from "./topology.js";
import {
  attachmentDigest,
  attachmentPath,
  buildAttachmentPrompt,
  downloadAttachment,
  isTextAttachment,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  StagedAttachment,
} from "./attachments.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const stateDir = resolve(root, ".discord-bridge");
const envFile = resolve(root, ".env.discord");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const commandDefinitions = buildTerminalCommands();
// VIEW_CHANNEL + SEND_MESSAGES + MANAGE_CHANNELS + MANAGE_ROLES.
// This is only an install-time request; Discord still displays the consent screen.
const INVITE_PERMISSIONS = "268438544";
const DEFAULT_ATTACHMENT_TTL_MS = 30 * 60_000;

function attachmentTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env.DISCORD_ATTACHMENT_TTL_MINUTES?.trim();
  if (!raw) return DEFAULT_ATTACHMENT_TTL_MS;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error("DISCORD_ATTACHMENT_TTL_MINUTES must be an integer from 1 to 1440");
  return minutes * 60_000;
}

function acquireLock(): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = resolve(stateDir, "bridge.pid");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid bridge.pid; inspect it before removing");
    try { process.kill(pid, 0); throw new Error("A bridge process is already running"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(lock);
    }
  }
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  process.on("exit", () => { try { if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); } catch {} });
}

function textChannel(value: unknown): value is TextChannel {
  return Boolean(value && typeof value === "object" && "type" in value && (value as { type: ChannelType }).type === ChannelType.GuildText);
}

function categoryChannel(value: unknown): value is CategoryChannel {
  return Boolean(value && typeof value === "object" && "type" in value && (value as { type: ChannelType }).type === ChannelType.GuildCategory);
}

function parentIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("parentId" in value)) return undefined;
  const parentId = (value as { parentId?: string | null }).parentId;
  return parentId ?? undefined;
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const attachmentTtl = attachmentTtlMs(process.env);
  const secrets = [config.token];
  const sshEnv = resolve(root, ".env.ssh");
  if (existsSync(sshEnv)) {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(sshEnv, "utf8")))) {
      if (/password|token|secret/i.test(key) && value) secrets.push(value);
    }
  }
  const localTmux = resolve(root, ".local-tools/usr/bin/tmux");
  const binary = process.env.TMUX_BIN || (existsSync(localTmux) ? localTmux : "tmux");
  const run = tmuxRunner(binary, "discord-bridge");
  const version = process.platform === "win32" ? "Windows ConPTY provider" : (await run(["-V"])).trim();
  if (process.argv.includes("--check")) {
    console.log(`Config valid (token hidden). ${version}. No Discord connection started.`);
    return;
  }

  acquireLock();
  let healthState = "connecting";
  let agentPresence: () => AgentPresence[] = () => [];
  const health = () => {
    const dest = resolve(stateDir, "health.json");
    writeFileSync(dest + ".tmp", JSON.stringify({ pid: process.pid, state: healthState, updatedAt: Date.now(), runtimeRoot: root, agents: agentPresence() }), { mode: 0o600 });
    renameSync(dest + ".tmp", dest);
  };
  health();
  const heartbeat = setInterval(health, 5000);
  heartbeat.unref();
  const ptyClient = process.platform === "win32" ? await ensurePtySupervisor(stateDir) : undefined;
  const channelSelections = new ChannelSessionStore(resolve(stateDir, "channel-sessions.json"));
  const guildSetups = new GuildSetupStore(resolve(stateDir, "guild-setup.json"));
  const categoryBindings = new CategoryBindingStore(resolve(stateDir, "category-bindings.json"));
  const channelBindings = new ChannelBindingStore(resolve(stateDir, "channel-bindings.json"));
  const directoryHistory = new DirectoryHistoryStore(resolve(stateDir, "directory-history.json"));
  const hostTargets = loadHostTargets(root);
  const hostExecutors = new Map(hostTargets.map(target => [target.id, new HostExecutor(target, root)]));
  const managedStore = new ManagedSessionStore(resolve(stateDir, "managed-sessions.json"));
  const managed = new Map<string, ManagedTerminal>();
  const agentHub = new AgentHub(resolve(stateDir, "agents.json"), config.guildId, config.ownerId);
  const remoteVscode = new RemoteVscodeRegistry(agentHub);
  const agentLabels = new Map<string, string>();
  agentPresence = () => agentHub.presence();
  const registerAgent = (machine: ReturnType<AgentHub["list"]>[number]) => {
    agentLabels.set(machine.id, machine.label);
    const executor = new AgentHostExecutor(machine, agentHub);
    if (!hostTargets.some(target => target.id === machine.id)) hostTargets.push(executor.target);
    hostExecutors.set(machine.id, executor);
  };
  for (const machine of agentHub.list()) registerAgent(machine);
  agentHub.onSnapshot = (machine, snapshot) => {
    remoteVscode.sync(machine.id, snapshot.vscode ?? [], new Set(vscodeInventory(stateDir).map(session => session.id)));
    for (const record of snapshot.terminals) {
      const prior = managed.get(record.id);
      if (prior && prior.record.machine !== machine.id) throw new Error("Agent terminal identity collision.");
    }
    registerAgent(machine);
    const stopped = new Set(channelBindings.list().filter(isStoppedBinding).map(binding => binding.terminalId));
    for (const record of snapshot.terminals) if (!stopped.has(record.id)) managed.set(record.id, new AgentTerminal(record, agentHub));
  };
  if (process.env.REMOTE_OPERATOR_AGENT_PORT) {
    const port = Number(process.env.REMOTE_OPERATOR_AGENT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid agent port.");
    const key = process.env.REMOTE_OPERATOR_TLS_KEY, cert = process.env.REMOTE_OPERATOR_TLS_CERT;
    if (Boolean(key) !== Boolean(cert)) throw new Error("Provide both TLS key and certificate.");
    await agentHub.listen(port, process.env.REMOTE_OPERATOR_AGENT_BIND || "127.0.0.1", key && cert ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined);
  }
  for (const record of managedStore.load()) {
    const target = hostTargets.find(candidate => candidate.id === record.machine);
    const executor = target ? hostExecutors.get(target.id) : undefined;
    if (!target || !executor || hostPlatform(target) === "win32") continue;
    const tmux = target.kind === "local" ? run : hostTmuxRunner(executor, target, record.socket);
    managed.set(record.id, new ManagedTmuxTerminal(record, tmux));
  }
  // Keep naturally exited terminals addressable for status/close after restart,
  // while explicitly stopped channels must not reappear as selectable sessions.
  const retainedPtyIds = new Set(channelBindings.list().filter(binding => !isStoppedBinding(binding)).map(binding => binding.terminalId));
  if (ptyClient) for (const record of await ptyClient.list()) {
    if (record.alive || retainedPtyIds.has(record.id)) managed.set(record.id, new PtyTerminal(record, ptyClient));
  }
  function rememberChannelDirectory(channelId: string): void {
    const binding = channelBindings.get(channelId);
    if (!binding || binding.guildId !== config.guildId || binding.status !== "ready" || !binding.terminalId) return;
    try {
      const target = configuredHostById(hostTargets, binding.hostId);
      directoryHistory.record(config.guildId, target.id, binding.cwd, hostPlatform(target));
    } catch { console.error("Could not save recent terminal directory; the terminal binding remains unchanged."); }
  }

  function providerOf(terminal: ManagedTerminal): string { return terminal instanceof PtyTerminal || (terminal instanceof AgentTerminal && terminal.record.id.startsWith("pty-")) ? "conpty" : "tmux"; }

  async function createTerminal(executor: HostExecutor, kind: "shell" | ManagedKind, cwd: string, requestId: string): Promise<ManagedTerminal> {
    const host = executor.target;
    requireWorkingDirectory(cwd, hostPlatform(host));
    if (executor instanceof AgentHostExecutor) {
      const terminal = await executor.create(kind, cwd, requestId);
      const prior = managed.get(terminal.record.id);
      if (prior && prior.record.machine !== terminal.record.machine) throw new SessionError("Agent returned an ID owned by another machine; channel was not retargeted.");
      managed.set(terminal.record.id, terminal);
      return terminal;
    }
    if (hostPlatform(host) === "win32") {
      if (host.kind !== "local" || !ptyClient) throw new SessionError("Remote Windows requires the forthcoming paired agent; SSH/tmux is not a Windows provider.");
      if (kind === "bash") throw new SessionError("Choose Default shell for native Windows. Bash is a Linux launch option.");
      const terminal = await ptyClient.create(cwd, host.id, kind, requestId);
      managed.set(terminal.record.id, terminal);
      return terminal;
    }
    const socket = host.kind === "local" ? "discord-bridge" : `remote-operator-${host.id}`;
    const tmux = host.kind === "local" ? run : hostTmuxRunner(executor, host, socket);
    const created = await createManagedTmux(tmux, kind === "shell" ? "bash" : kind, cwd, host.id, socket, "terminal");
    if (/\bdead=1\b/.test(await created.terminal.status())) {
      await created.terminal.stop().catch(() => {});
      throw new SessionError(`Terminal could not start on ${host.label}.`);
    }
    managedStore.add(created.record);
    managed.set(created.record.id, created.terminal);
    return created.terminal;
  }
  const attachmentCleanupLocations = new Map<string, Set<string>>();
  for (const target of hostTargets) attachmentCleanupLocations.set(target.id, new Set([target.cwd]));
  for (const record of managedStore.load()) {
    const locations = attachmentCleanupLocations.get(record.machine);
    if (locations) locations.add(record.cwd);
  }
  for (const binding of channelBindings.list(config.guildId)) {
    if (binding.terminalId?.startsWith("tmux-") || binding.terminalId?.startsWith("pty-")) attachmentCleanupLocations.get(binding.hostId)?.add(binding.cwd);
  }
  for (const [machine, locations] of attachmentCleanupLocations) {
    const executor = hostExecutors.get(machine);
    if (!executor) continue;
    for (const cwd of locations) void executor.cleanupAttachmentInbox(attachmentTtl, cwd).catch(() => {});
  }
  type SessionView = { id: string; label: string; machine: string; machineLabel?: string; cwd?: string | null;
    provider: string; kind?: string; generation?: string; remote?: boolean; sourceMachine?: string; platform?: HostPlatform; cwdSource?: "shellIntegration" | "creationOptions" | "workspace";
    shared?: boolean; alive?: boolean; reachable?: boolean; inputProtocol?: string };
  const remoteViews = (): SessionView[] => remoteVscode.list().map(session => ({ ...session, provider: "vscode-agent",
    machineLabel: `${agentLabels.get(session.machine) ?? session.machine}${session.remote ? ` → ${session.sourceMachine}` : ""}`,
    reachable: agentHub.online(session.machine) }));
  const sessions = (): SessionView[] => [
    ...vscodeSessions(stateDir).map(session => ({ ...session, provider: "vscode" })),
    ...remoteViews().filter(session => session.alive && session.shared),
    ...[...managed.values()].map(terminal => ({ id: terminal.record.id, label: terminal.record.label, machine: terminal.record.machine, cwd: terminal.record.cwd, provider: providerOf(terminal), kind: terminal.record.kind })),
  ];
  const inventory = async (machine?: string): Promise<SessionView[]> => Promise.all(([
    ...vscodeInventory(stateDir).map(session => ({ ...session, provider: "vscode" })),
    ...remoteViews(),
    ...[...managed.values()].map(terminal => ({ id: terminal.record.id, label: terminal.record.label, machine: terminal.record.machine, cwd: terminal.record.cwd, alive: true, shared: true, provider: providerOf(terminal), kind: terminal.record.kind })),
  ] as SessionView[]).filter(session => !machine || (() => {
    try { return resolveAttachmentTarget(hostTargets, session).host.id === machine; } catch { return false; }
  })()).map(async session => {
    if (!session.shared) return { ...session, reachable: session.reachable ?? true };
    try {
      const status = await getTerminal(session.id).status();
      return { ...session, alive: !/\bdead=1\b|\balive=false\b/.test(status), reachable: true };
    } catch { return { ...session, alive: false, reachable: false }; }
  }));
  const getTerminal = (id: string): TerminalControl => {
    if (id.startsWith("vsc-")) {
      const remote = remoteVscode.get(id);
      const local = vscodeInventory(stateDir).find(session => session.id === id);
      if (remote && local) throw new SessionError("Ambiguous VS Code identity; no action was dispatched.");
      if (remote) { remoteVscode.require(id, remote.generation); return new RemoteVscodeTerminal(remote, remoteVscode); }
      return new VscodeTerminal(stateDir, id, local?.generation);
    }
    const terminal = managed.get(id);
    if (terminal) return terminal;
    throw new SessionError("Unknown session. Use /sessions, share a terminal in VS Code, then run /terminal attach in the operator channel.");
  };
  const getSession = (id: string) => sessions().find(session => session.id === id);
  const getExecutor = (sessionId: string): HostExecutor => {
    const session = getSession(sessionId);
    if (!session) throw new SessionError("Terminal is no longer available; use /terminal attach in the operator channel.");
    const target = resolveAttachmentTarget(hostTargets, session).host;
    const executor = target ? hostExecutors.get(target.id) : undefined;
    if (!target || !executor) throw new SessionError(`Host ${session.machine} is not configured.`);
    return executor;
  };

  function validateChannelTarget(channelId: string, sessionId: string, capturedGeneration?: string): void {
    const session = getSession(sessionId);
    const binding = channelBindings.get(channelId);
    const identity = channelSelections.identity(channelId);
    const category = binding && categoryBindings.get(binding.categoryId);
    if (!session || !binding || binding.status !== "ready" || !category) throw new SessionError("Terminal binding is unavailable; create or attach a terminal from the operator channel.");
    validateAttachmentTarget(hostTargets, session, category, binding);
    if ((identity && (session.machine !== identity.machine || session.provider !== identity.provider))
      || (capturedGeneration && session.generation !== capturedGeneration)) {
      throw new SessionError("The original terminal identity or sharing generation changed. Reattach explicitly; no input was redirected.");
    }
  }

  async function stageMessageAttachments(
    message: { id: string; attachments: { values(): Iterable<{ name?: string | null; url: string; size?: number; contentType?: string | null }> } },
    sessionId: string,
    targetSession: { provider: string; cwd?: string | null },
  ): Promise<StagedAttachment[]> {
    const attachments = [...message.attachments.values()];
    if (!attachments.length) return [];
    if (attachments.length > MAX_ATTACHMENTS) throw new SessionError(`Attach at most ${MAX_ATTACHMENTS} files per message.`);
    if (!["tmux", "conpty"].includes(targetSession.provider) || typeof targetSession.cwd !== "string") throw new SessionError("File attachments require a managed terminal; VS Code shared tabs support text input only.");
    const executor = getExecutor(sessionId);
    const staged: StagedAttachment[] = [];
    try {
      for (let index = 0; index < attachments.length; index++) {
        const attachment = attachments[index];
        if (!isTextAttachment(attachment)) throw new SessionError(`Attachment ${attachment.name ?? index + 1} is not a supported text file.`);
        if (attachment.size !== undefined && attachment.size > MAX_ATTACHMENT_BYTES) {
          throw new SessionError(`Attachment ${attachment.name ?? index + 1} exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
        }
        let data: Buffer;
        try {
          data = await downloadAttachment(attachment, MAX_ATTACHMENT_BYTES);
        } catch (error) {
          throw new SessionError(error instanceof Error ? error.message : "Attachment download failed.");
        }
        const relativePath = attachmentPath(message.id, index, attachment.name);
        await executor.writeFile(relativePath, data, targetSession.cwd);
        staged.push({
          originalName: attachment.name?.slice(0, 120) || `attachment-${index + 1}`,
          relativePath,
          bytes: data.length,
          sha256: attachmentDigest(data),
        });
      }
      return staged;
    } catch (error) {
      await Promise.allSettled(staged.map(file => executor.removeFile(file.relativePath, targetSession.cwd!)));
      throw error;
    }
  }

  function scheduleAttachmentCleanup(sessionId: string, cwd: string, files: StagedAttachment[]): void {
    if (!files.length) return;
    const executor = getExecutor(sessionId);
    const timer = setTimeout(() => {
      void Promise.allSettled(files.map(file => executor.removeFile(file.relativePath, cwd)));
    }, attachmentTtl);
    timer.unref();
  }

  const messageContentEnabled = /^true$/i.test(process.env.DISCORD_MESSAGE_CONTENT_INTENT ?? "");
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (messageContentEnabled) intents.push(GatewayIntentBits.MessageContent);
  const client = new Client({
    intents,
    allowedMentions: { parse: [] },
  });
  client.on(Events.Error, () => console.error("Discord client error; no credentials or payloads logged."));
  client.on(Events.ShardDisconnect, () => { notifications.transportLost(); healthState = "disconnected"; health(); console.log("Discord disconnected. Local terminals continue; commands are not replayed."); });
  client.on(Events.ShardResume, () => { void notifications.resume().catch(() => console.error("Notification reconnect failed; no history replayed.")); healthState = "ready"; health(); });
  const queues = new ActionQueue();
  const notifications: CodexNotifications = new CodexNotifications(new NotificationStore(resolve(stateDir, "notifications.json")), {
    secrets,
    describe: describeNotificationTarget,
    read: (target, request) => getExecutor(target.terminalId).readCodexEvents(request),
    capture: (target, lines) => queues.run(`session:${target.terminalId}`, async () => {
      if (!sameNotificationTarget(target, await describeNotificationTarget(target.channelId))) throw new SessionError("Notification terminal changed before capture.");
      return getTerminal(target.terminalId).output(lines);
    }),
    send: async (binding, message, stillCurrent) => {
      const channel = await client.channels.fetch(binding.channelId);
      if (!textChannel(channel)) throw new SessionError("Notification channel unavailable before delivery.");
      const fresh = await describeNotificationTarget(binding.channelId);
      if (!stillCurrent() || !sameNotificationTarget(binding, fresh)) throw new SessionError("Notification target changed before delivery.");
      return channel.send(message);
    },
  });
  let registered = false;
  const provisioning = new Map<string, Promise<void>>();

  function categoryForChannel(channelId: string, parentId: string | undefined): CategoryBindingRecord | undefined {
    const binding = channelBindings.get(channelId);
    if (!binding || binding.guildId !== config.guildId) return undefined;
    if (!parentId || binding.categoryId !== parentId) throw new SessionError("This channel moved away from its registered machine category; it is fail-closed.");
    const category = categoryBindings.get(binding.categoryId);
    if (!category || category.guildId !== config.guildId || category.hostId !== binding.hostId) throw new SessionError("This terminal channel is no longer bound to a registered machine.");
    const target = configuredHostById(hostTargets, binding.hostId);
    boundTerminalDirectory(category, binding, hostPlatform(target));
    return category;
  }

  function channelRoute(channelId: string, parentId: string | undefined): BoundTerminalChannelContext {
    const binding = channelBindings.get(channelId);
    return { guildId: config.guildId, channelId, parentId: parentId ?? null, bootstrapChannelId: config.channelId,
      orchestratorChannelId: guildSetups.get(config.guildId)?.orchestratorChannelId,
      binding, category: binding ? categoryBindings.get(binding.categoryId) : undefined };
  }

  function terminalChannelAllowed(channelId: string, parentId: string | undefined): boolean {
    return isBoundTerminalChannel(channelRoute(channelId, parentId));
  }

  function orchestratorAllowed(channelId: string): boolean {
    return guildSetups.get(config.guildId)?.orchestratorChannelId === channelId;
  }

  function boundSessionId(channelId: string, parentId: string | undefined): string {
    categoryForChannel(channelId, parentId);
    return requireBoundTerminalId(channelRoute(channelId, parentId));
  }

  function sameNotificationTarget(a: NotificationTarget, b: NotificationTarget): boolean {
    return a.guildId === b.guildId && a.channelId === b.channelId && a.machine === b.machine
      && a.terminalId === b.terminalId && a.generation === b.generation && a.provider === b.provider && a.cwd === b.cwd;
  }
  async function describeNotificationTarget(channelId: string): Promise<NotificationTarget> {
    const channel = await client.channels.fetch(channelId);
    if (!textChannel(channel) || channel.guildId !== config.guildId || !terminalChannelAllowed(channelId, channel.parentId ?? undefined)) throw new SessionError("Notification channel is no longer authorized.");
    const terminalId = boundSessionId(channelId, channel.parentId ?? undefined);
    const session = getSession(terminalId), terminal = getTerminal(terminalId);
    if (!session || terminalId === "demo" || typeof session.cwd !== "string") throw new SessionError("Create or attach a live terminal before enabling /notify.");
    validateChannelTarget(channelId, terminalId, session.generation);
    const status = await terminal.status();
    if (/\bdead=1\b|\balive=false\b/.test(status)) throw new SessionError("Notification terminal has exited.");
    const managedTerminal = managed.get(terminalId);
    const nativeGeneration = managedTerminal instanceof PtyTerminal || managedTerminal instanceof AgentTerminal ? managedTerminal.record.generation : undefined;
    let generation = session.generation ?? nativeGeneration;
    if (!generation) {
      if (!managedTerminal) throw new SessionError("Notification terminal has no stable identity.");
      generation = createHash("sha256").update(JSON.stringify(managedTerminal.record)).digest("hex").slice(0, 32);
    }
    const executor = getExecutor(terminalId);
    return { guildId: config.guildId, channelId, terminalId, machine: executor.target.id,
      provider: session.provider, generation, cwd: session.cwd };
  }

  async function requireCategoryPermissions(guild: Guild): Promise<void> {
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new SessionError("Bot needs Manage Channels to create or bind machine categories. Re-authorize it with the install link shown in the bridge log.");
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) throw new SessionError("Bot needs Manage Roles to apply private category permissions. Re-authorize it with the install link shown in the bridge log.");
  }

  async function secureCategory(category: CategoryChannel, guild: Guild, botId: string): Promise<void> {
    await requireCategoryPermissions(guild);
    await category.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }, { type: OverwriteType.Role });
    for (const userId of trustedDiscordUserIds(config)) {
      await category.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, UseApplicationCommands: true }, { type: OverwriteType.Member });
    }
    await category.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageChannels: true }, { type: OverwriteType.Member });
  }

  async function probeHost(hostId: string, cwd: string): Promise<HostExecutor> {
    const target = configuredHostById(hostTargets, hostId);
    const executor = target ? hostExecutors.get(target.id) : undefined;
    if (!target || !executor) throw new SessionError(`Machine ${hostId} is not configured in the local host registry.`);
    requireWorkingDirectory(cwd, hostPlatform(target));
    if (executor instanceof AgentHostExecutor) { await executor.profile(cwd); return executor; }
    const result = await executor.run(hostPlatform(target) === "win32" ? "(Get-Location).Path" : "pwd", 10_000, cwd);
    if (result.code !== 0 || result.timedOut) throw new SessionError(`Could not reach ${target.label} at ${cwd}. ${redact(formatHostResult(result), secrets).slice(0, 600)}`);
    if (hostPlatform(target) === "win32") {
      if (target.kind !== "local" || !ptyClient) throw new SessionError("This Windows machine needs a connected native agent.");
      await ptyClient.request("describe");
    } else {
      await probeTmux(executor, cwd, run, secrets);
    }
    return executor;
  }

  async function attachManagedSession(guild: Guild, category: CategoryChannel, record: CategoryBindingRecord, id: string, name: string | null, expectedGeneration?: string, deadline = Date.now() + 60_000): Promise<TextChannel> {
    const checkAttach = () => {
      if (Date.now() >= deadline) throw new SessionError("Attach request expired; no further action performed.");
      const current = categoryBindings.get(category.id);
      if (!current || current.guildId !== guild.id || current.hostId !== record.hostId) throw new SessionError("Category target changed during attach.");
      const selected = getSession(id);
      if (!selected || id === "demo") throw new SessionError("Choose a live managed terminal or a shared VS Code tab from /sessions.");
      if (expectedGeneration && selected.generation !== expectedGeneration) throw new SessionError("Terminal sharing changed during attach. Choose the current tab explicitly.");
      return { selected, target: validateAttachmentTarget(hostTargets, selected, current) };
    };
    const initial = checkAttach();
    // Pin the sharing generation for all subsequent checks, including local tabs.
    expectedGeneration ??= initial.target.identity?.generation;
    const terminal = getTerminal(id);
    if (/\bdead=1\b|\balive=false\b/.test(await terminal.status())) throw new SessionError("This terminal has exited.");
    checkAttach();
    await secureCategory(category, guild, client.user!.id);
    checkAttach();
    for (const binding of channelBindings.list(guild.id)) {
      if (binding.terminalId !== id) continue;
      if (isStoppedBinding(binding)) throw new SessionError("This terminal was explicitly stopped.");
      const existing = await guild.channels.fetch(binding.channelId).catch(error => {
        if (error && typeof error === "object" && "code" in error && error.code === 10003) return null;
        throw error;
      });
      const { selected, target } = checkAttach();
      if (existing) {
        if (!textChannel(existing) || binding.categoryId !== category.id || (existing.parentId !== category.id && existing.parentId !== null)) throw new SessionError(`Terminal is already attached to <#${binding.channelId}>; its channel/category cannot be retargeted.`);
        // Explicit reattach may renew sharing only for the same original host,
        // relay and provider. A queued or reconnecting input never renews it.
        validateAttachmentTarget(hostTargets, selected, record, { ...binding, terminalGeneration: target.identity?.generation });
        const identity = channelSelections.identity(existing.id);
        if (target.identity && identity && (identity.machine !== target.identity.machine || identity.provider !== target.identity.provider)) throw new SessionError("Original terminal route changed; no channel was retargeted.");
        if (existing.parentId === null) {
          await existing.setParent(category.id, { lockPermissions: true });
          checkAttach();
        }
        const linked = await guild.channels.fetch(existing.id, { force: true });
        checkAttach();
        if (!textChannel(linked) || linked.parentId !== category.id) throw new SessionError("Attachment channel moved during attach; no binding was renewed.");
        channelBindings.set({ ...binding, ...(target.identity ? { provider: target.identity.provider, terminalGeneration: target.identity.generation, relayMachine: target.relayMachine } : {}), updatedAt: Date.now() });
        channelSelections.set(existing.id, id, target.identity);
        return linked;
      }
    }
    checkAttach();
    const created = await guild.channels.create({ name: channelDisplayName(name ?? "terminal"), type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        ...trustedDiscordUserIds(config).map(id => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.UseApplicationCommands] })),
        { id: client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ] });
    if (!textChannel(created)) throw new SessionError("Discord did not create a text channel.");
    let fresh: ReturnType<typeof checkAttach>;
    try {
      fresh = checkAttach();
      if (/\bdead=1\b|\balive=false\b/.test(await terminal.status())) throw new SessionError("Terminal exited during attach.");
      fresh = checkAttach();
    } catch (error) { await created.delete().catch(() => undefined); throw error; }
    // Persist before adding the parent so channel events cannot create a second process.
    const now = Date.now();
    channelBindings.set({ guildId: guild.id, channelId: created.id, categoryId: record.categoryId, hostId: record.hostId, cwd: fresh.selected.cwd!, status: "ready", terminalId: id,
      ...(fresh.target.identity ? { provider: fresh.target.identity.provider, terminalGeneration: fresh.target.identity.generation, relayMachine: fresh.target.relayMachine } : {}), createdAt: now, updatedAt: now });
    // A parent update failure retains this exact binding for an explicit retry.
    await created.setParent(category.id, { lockPermissions: true });
    const linked = await guild.channels.fetch(created.id, { force: true });
    checkAttach();
    if (!textChannel(linked) || linked.parentId !== category.id) throw new SessionError("Attachment channel moved during attach. Its original terminal was left running.");
    channelSelections.set(created.id, id, fresh.target.identity);
    return linked;
  }

  async function createManagedChannel(guild: Guild, category: CategoryChannel, record: CategoryBindingRecord, name: string | null, cwd: string | null, deadline: number): Promise<TextChannel> {
    const target = configuredHostById(hostTargets, record.hostId);
    await secureCategory(category, guild, client.user!.id);
    return createTerminalChannel({
      category: record, platform: hostPlatform(target), cwd: cwd,
      deadline: deadline, bindings: channelBindings,
      currentCategory: () => categoryBindings.get(category.id), probe: cwd => probeHost(record.hostId, cwd),
      createPrivate: async () => {
        const channel = await guild.channels.create({ name: channelDisplayName(name ?? "terminal"), type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
            ...trustedDiscordUserIds(config).map(id => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.UseApplicationCommands] })),
            { id: client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ] });
        if (!textChannel(channel)) throw new SessionError("Discord did not create a text channel.");
        return channel;
      },
      link: async channel => {
        await channel.setParent(category.id, { lockPermissions: true });
        const linked = await guild.channels.fetch(channel.id, { force: true });
        if (!textChannel(linked)) throw new SessionError("New terminal channel is unavailable after parenting.");
        return linked;
      },
      remove: channel => channel.delete(), provision: channel => provisionChannel(channel, record),
    });
  }

  async function bindCategory(guild: Guild, category: CategoryChannel, hostId: string, cwd: string, createdAt = Date.now(), label = category.name): Promise<CategoryBindingRecord> {
    const current = categoryBindings.get(category.id);
    if (current && (current.hostId !== hostId || current.defaultCwd !== cwd)) throw new SessionError("This category already targets another machine or directory. Create a new project category; existing terminals cannot be retargeted by /machine bind.");
    await probeHost(hostId, cwd);
    await secureCategory(category, guild, client.user!.id);
    const record: CategoryBindingRecord = {
      guildId: guild.id,
      categoryId: category.id,
      hostId,
      label: categoryDisplayName(label, hostId),
      defaultCwd: cwd,
      createdAt: current?.createdAt ?? createdAt,
      updatedAt: Date.now(),
    };
    categoryBindings.set(record);
    return record;
  }

  async function provisionChannel(channel: TextChannel, category: CategoryBindingRecord): Promise<void> {
    if (channel.guild.id !== config.guildId || channel.parentId !== category.categoryId) return;
    const existing = channelBindings.get(channel.id);
    if (existing?.status === "ready" && existing.terminalId) {
      boundTerminalDirectory(category, existing, hostPlatform(configuredHostById(hostTargets, category.hostId)));
      // Selection storage is only a mirror of an existing binding, never authority.
      const session = getSession(existing.terminalId);
      if (session && (existing.provider === "vscode" || existing.provider === "vscode-agent") && existing.terminalGeneration) {
        validateChannelTarget(channel.id, existing.terminalId);
        channelSelections.set(channel.id, existing.terminalId, { machine: session.machine, generation: existing.terminalGeneration, provider: existing.provider });
      } else if (!existing.provider || existing.provider === "tmux" || existing.provider === "conpty") channelSelections.set(channel.id, existing.terminalId);
      return;
    }
    // Existing failed/stopped/ambiguous creations are never replayed.
    if (existing && existing.status !== "provisioning") return;
    const previous = provisioning.get(channel.id);
    if (previous) return previous;
    const target = configuredHostById(hostTargets, category.hostId);
    const cwd = terminalProvisionDirectory(category, hostPlatform(target), existing);
    const deadline = existing?.provisioningDeadline ?? Date.now() + 60_000;
    const task = (async () => {
      const now = Date.now();
      const pending: ChannelBindingRecord = {
        guildId: channel.guild.id, channelId: channel.id, categoryId: category.categoryId,
        hostId: category.hostId, cwd, status: "provisioning", provisioningDeadline: deadline,
        createdAt: existing?.createdAt ?? channel.createdTimestamp ?? now, updatedAt: now,
      };
      channelBindings.set(pending);
      const checkProvision = () => {
        if (Date.now() >= deadline) throw new SessionError("Terminal creation expired; an already-delivered request may have completed. Inspect /sessions before retrying.");
        const current = categoryBindings.get(category.categoryId);
        const cached = channel.guild.channels.cache.get(channel.id);
        const parentId = cached?.parentId;
        if (!current || current.guildId !== category.guildId || current.hostId !== category.hostId || parentId !== category.categoryId) throw new SessionError("Channel/category target changed during provisioning.");
        const persisted = channelBindings.get(channel.id);
        if (!persisted || persisted.channelId !== channel.id || persisted.provisioningDeadline !== deadline
          || !sameWorkingDirectory(terminalProvisionDirectory(current, hostPlatform(target), persisted), cwd, hostPlatform(target))) throw new SessionError("Terminal creation directory changed; no process was redirected.");
      };
      let created: ManagedTerminal | undefined;
      try {
        checkProvision();
        const executor = await probeHost(category.hostId, cwd);
        checkProvision();
        created = await createTerminal(executor, "shell", cwd, `channel:${channel.id}`);
        checkProvision();
        const ready: ChannelBindingRecord = { ...pending, status: "ready", terminalId: created.record.id, provisioningDeadline: undefined, error: undefined, updatedAt: Date.now() };
        channelBindings.set(ready);
        channelSelections.set(channel.id, created.record.id);
        await channel.send({ content: `Terminal ready on **${category.hostId}** in \`${cwd}\`. Normal messages are submitted to this terminal; use /output, /status or /key for high-level control.`, allowedMentions: { parse: [] } }).catch(() => {
          audit(stateDir, { action: "provision-notification", channelId: channel.id, phase: "failed", terminalId: created!.record.id });
        });
      } catch (error) {
        const message = error instanceof SessionError ? error.message : "Terminal provisioning failed. Check host, tmux and working directory.";
        channelBindings.set({ ...pending, status: created ? "orphaned" : "failed", ...(created ? { terminalId: created.record.id } : {}), error: redact(message, secrets).slice(0, 500), updatedAt: Date.now() });
        await channel.send({ content: `Terminal provisioning failed: ${redact(message, secrets).slice(0, 700)}. Inspect /sessions before retrying; no input or creation is replayed automatically.`, allowedMentions: { parse: [] } }).catch(() => {});
      }
    })();
    provisioning.set(channel.id, task);
    try { await task; } finally { provisioning.delete(channel.id); }
  }

  async function stopManagedSession(sessionId: string): Promise<ManagedTerminal> {
    const terminal = managed.get(sessionId);
    if (!terminal) throw new SessionError("Only managed terminals can be stopped from Discord. VS Code sharing must be revoked from the extension.");
    const status = await terminal.status();
    if (!/\bdead=1\b|\balive=false\b/.test(status)) await terminal.stop();
    managed.delete(sessionId);
    if (sessionId.startsWith("tmux-")) managedStore.remove(sessionId);
    return terminal;
  }

  async function reconcileChannels(guild: Guild): Promise<void> {
    for (const category of categoryBindings.list(guild.id)) {
      for (const value of guild.channels.cache.values()) {
        if (!textChannel(value) || value.parentId !== category.categoryId) continue;
        const existing = channelBindings.get(value.id);
        const isNewSinceBinding = (value.createdTimestamp ?? 0) >= category.createdAt;
        if (!existing && !isNewSinceBinding) continue;
        // An explicit stop or failed/ambiguous creation never starts new work on restart.
        if (existing) continue;
        void provisionChannel(value, category).catch(() => console.error("Channel reconciliation refused; inspect its binding. No automatic retry."));
      }
    }
  }

  client.on(Events.ChannelCreate, channel => {
    if (!registered || !textChannel(channel) || !channel.guild || !channel.parentId) return;
    const category = categoryBindings.get(channel.parentId);
    if (category && category.guildId === channel.guild.id) void provisionChannel(channel, category).catch(() => console.error("Channel provisioning refused; inspect its binding. No automatic retry."));
  });

  client.on(Events.MessageCreate, message => {
    if (message.author.bot || !message.guildId || message.guildId !== config.guildId || !authorizedGuild(config, message.author.id, message.guildId)) return;
    const parentId = parentIdOf(message.channel);
    const binding = channelBindings.get(message.channelId);
    const attachments = [...message.attachments.values()];
    if (!binding || !terminalChannelAllowed(message.channelId, parentId)) return;
    if (!textChannel(message.channel) || binding.status !== "ready") return;
    if (!claimInteraction(stateDir, message.id, message.createdTimestamp)) return;
    const sessionId = binding.terminalId;
    if (!sessionId) return;
    const capturedGeneration = getSession(sessionId)?.generation;
    const task = queues.run(`session:${sessionId}`, async () => {
      if (Date.now() - message.createdTimestamp > 60_000) throw new SessionError("Message expired in queue; it was not sent.");
      if (!message.content && !attachments.length) throw new SessionError("Discord did not provide message content. Enable Message Content Intent in the Developer Portal and set DISCORD_MESSAGE_CONTENT_INTENT=true, then restart the bridge.");
      if (attachments.length && !messageContentEnabled) throw new SessionError("File attachments need Message Content Intent so the caption is preserved. Enable it in the Developer Portal, set DISCORD_MESSAGE_CONTENT_INTENT=true, then restart the bridge.");
      if (message.content) validateInput(message.content);
      if (boundSessionId(message.channelId, parentIdOf(message.channel)) !== sessionId) throw new SessionError("Channel target changed while queued; input was not sent.");
      validateChannelTarget(message.channelId, sessionId, capturedGeneration);
      const terminal = getTerminal(sessionId);
      const targetSession = getSession(sessionId);
      if (!targetSession) throw new SessionError("Selected terminal is no longer available; use /terminal attach in the operator channel.");
      const terminalCwd = targetSession.cwd;
      const status = await terminal.status();
      if (/\bdead=1\b|\balive=false\b/.test(status)) throw new SessionError("Selected terminal has exited; inspect /status and create a new terminal channel.");
      const staged = await stageMessageAttachments(message, sessionId, targetSession);
      const input = staged.length ? buildAttachmentPrompt(message.content, staged) : message.content;
      validateInput(input);
      try {
        if (boundSessionId(message.channelId, parentIdOf(message.channel)) !== sessionId) throw new SessionError("Channel target changed before submit; input was not sent.");
        validateChannelTarget(message.channelId, sessionId, capturedGeneration);
        notifications.pauseForInput(sessionId, input);
        await terminal.send(input, message.createdTimestamp + 60_000);
      } catch (error) {
        // A failed RPC may have delivered input. Keep staged files for the same
        // grace period so a running application can finish reading them.
        if (typeof terminalCwd === "string") scheduleAttachmentCleanup(sessionId, terminalCwd, staged);
        throw error;
      }
      if (typeof terminalCwd === "string") scheduleAttachmentCleanup(sessionId, terminalCwd, staged);
      audit(stateDir, {
        id: message.id,
        user: message.author.id,
        action: "message-send",
        sessionId,
        phase: "completed",
        inputLength: input.length,
        attachmentCount: staged.length,
        attachmentBytes: staged.reduce((sum, file) => sum + file.bytes, 0),
        attachmentSha256: staged.map(file => file.sha256),
      });
      if (staged.length) {
        const summary = staged.map(file => `${file.originalName} (${file.bytes} bytes, sha256:${file.sha256.slice(0, 12)})`).join(", ");
        await message.reply({ content: `Attached file${staged.length === 1 ? "" : "s"} staged and prompt submitted: ${summary}. Files are cleaned after ${Math.round(attachmentTtl / 60_000)} minutes.`, allowedMentions: { parse: [] } }).catch(() => {});
      }
    });
    void task.catch(async error => {
      const content = error instanceof SessionError ? error.message : "Message could not be submitted. Inspect /output before retrying.";
      await message.reply({ content: redact(content, secrets).slice(0, 1800), allowedMentions: { parse: [] } }).catch(() => {});
    });
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
      try {
        if (!registered || !authorizedGuild(config, interaction.user.id, interaction.guildId)) { await interaction.respond([]); return; }
        const focused = interaction.options.getFocused(true);
        const needle = String(focused.value).toLowerCase();
        if (interaction.commandName === "machine" || interaction.commandName === "sessions") {
          if (!orchestratorAllowed(interaction.channelId) && !(interaction.commandName === "sessions" && terminalChannelAllowed(interaction.channelId, parentIdOf(interaction.channel)))) { await interaction.respond([]); return; }
          await interaction.respond(hostTargets.filter(target => `${target.id} ${target.label} ${target.kind} ${target.host ?? ""} ${target.port ?? ""}`.toLowerCase().includes(needle)).slice(0, 25)
            .map(target => ({ name: `${target.label} · ${target.kind === "ssh" ? `SSH ${target.host}:${target.port}` : "local"} [${target.id}]`.slice(0, 100), value: target.id })));
        } else if (interaction.commandName === "terminal" && interaction.options.getSubcommand(false) === "create-channel" && focused.name === "cwd" && orchestratorAllowed(interaction.channelId)) {
          const categoryId = interaction.options.get("category")?.value;
          const category = typeof categoryId === "string" ? categoryBindings.get(categoryId) : undefined;
          if (!category || category.guildId !== config.guildId) { await interaction.respond([]); return; }
          const platform = hostPlatform(configuredHostById(hostTargets, category.hostId));
          const recent = directoryHistory.list(config.guildId, category.hostId, platform);
          const context = { guildId: config.guildId, hostId: category.hostId, platform, recent, defaultCwd: category.defaultCwd };
          await interaction.respond(directoryChoices({ ...context, query: needle }).filter(choice => {
            const cwd = resolveDirectoryChoice({ ...context, value: choice.value })!;
            return redact(cwd, secrets) === cwd;
          }));
        } else if (interaction.commandName === "terminal" && interaction.options.getSubcommand(false) === "attach" && orchestratorAllowed(interaction.channelId)) {
          const categoryId = interaction.options.get("category")?.value;
          const category = typeof categoryId === "string" ? categoryBindings.get(categoryId) : undefined;
          await interaction.respond(sessions().filter(s => {
            if (s.id === "demo" || !`${s.id} ${sessionDisplayName(s)}`.toLowerCase().includes(needle)) return false;
            try {
              if (category) validateAttachmentTarget(hostTargets, s, category);
              else resolveAttachmentTarget(hostTargets, s);
              return true;
            } catch { return false; }
          }).slice(0, 25).map(s => ({ name: redact(sessionChoiceName(s), secrets), value: s.id })));
        } else await interaction.respond([]);
      } catch { try { await interaction.respond([]); } catch {} }
      return;
    }
    const supported = ["sessions", "status", "output", "send", "key", "interrupt", "run", "gpu", "setup", "machine", "terminal", "notify"];
    if (!interaction.isChatInputCommand() || !supported.includes(interaction.commandName)) return;
    try {
      const action = interaction.commandName;
      const channelId = interaction.channelId;
      if (!registered || !channelId || !authorizedGuild(config, interaction.user.id, interaction.guildId)) {
        await interaction.reply({ content: "This bridge is restricted to its configured trusted users and server.", flags: MessageFlags.Ephemeral });
        return;
      }
      // Acknowledge before any state reads, permission checks or host/tmux work.
      // Discord gives an interaction only a short window for this initial response.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const parentId = parentIdOf(interaction.channel);
      const subcommand = action === "machine" || action === "terminal" || action === "notify" ? interaction.options.getSubcommand() : undefined;
      if (action === "setup") {
        if (!authorized(config, interaction.user.id, interaction.guildId, channelId)) throw new SessionError("Run /setup from the configured bootstrap channel.");
      } else if (action === "machine" || (action === "terminal" && (subcommand === "create-channel" || subcommand === "attach"))) {
        if (!orchestratorAllowed(channelId)) throw new SessionError("Run /setup in the operator channel first; machine management is restricted there.");
      } else if (!(action === "sessions" && orchestratorAllowed(channelId)) && !terminalChannelAllowed(channelId, parentId)) {
        throw new SessionError("Use terminal controls in a bound child channel. In the operator channel, use /terminal create-channel or /terminal attach.");
      }
      const attachSessionId = action === "terminal" && subcommand === "attach" ? interaction.options.getString("session", true) : undefined;
      const text = action === "send" ? interaction.options.getString("text", true) : undefined;
      const key = action === "key" ? interaction.options.getString("key", true) as TerminalKey : undefined;
      const command = action === "run" ? interaction.options.getString("command", true) : undefined;
      const timeoutSeconds = action === "run" ? interaction.options.getInteger("timeout") ?? 15 : 15;
      const confirmLifecycle = action === "terminal" && (subcommand === "stop" || subcommand === "close")
        ? interaction.options.getBoolean("confirm", true) : false;
      if (text !== undefined) validateInput(text);
      if (command !== undefined) validateInput(command);
      if (!claimInteraction(stateDir, interaction.id, interaction.createdTimestamp)) {
        await interaction.editReply({ content: "Duplicate or expired request; no action performed." });
        return;
      }
      const lifecycleAction = action === "terminal" && (subcommand === "stop" || subcommand === "close");
      const sessionAction = ["status", "output", "send", "key", "interrupt", "run", "gpu"].includes(action);
      const capturedBinding = channelBindings.get(channelId);
      const hostAction = action === "run" || action === "gpu";
      const capturedHostBinding = hostAction && capturedBinding ? (categoryForChannel(channelId, parentId), capturedBinding) : undefined;
      const stoppedStatus = action === "status" && isStoppedBinding(capturedBinding);
      const pinnedSessionId = attachSessionId ? attachSessionId
        : lifecycleAction ? capturedBinding?.terminalId
        : capturedHostBinding || stoppedStatus ? capturedBinding?.terminalId
        : sessionAction ? boundSessionId(channelId, parentId) : undefined;
      const capturedGeneration = pinnedSessionId ? getSession(pinnedSessionId)?.generation : undefined;
      const queueKey = hostAction ? `host:${capturedHostBinding?.hostId ?? getSession(pinnedSessionId!)?.machine ?? channelId}`
        : pinnedSessionId ? `session:${pinnedSessionId}` : `channel:${channelId}`;
      const task = queues.run(queueKey, async () => {
        if (Date.now() - interaction.createdTimestamp > 60_000) throw new Error("Request expired in queue");
        const isTargetAction = sessionAction;
        const existingBinding = action === "terminal" ? channelBindings.get(channelId) : undefined;
        if (capturedHostBinding || stoppedStatus) {
          categoryForChannel(channelId, parentIdOf(interaction.channel));
          const current = channelBindings.get(channelId);
          if (!current || current.hostId !== capturedBinding?.hostId || current.cwd !== capturedBinding?.cwd || current.terminalId !== capturedBinding?.terminalId) throw new SessionError("Channel target changed while queued; no action performed.");
        } else if (sessionAction && boundSessionId(channelId, parentIdOf(interaction.channel)) !== pinnedSessionId) throw new SessionError("Channel target changed while queued; no action performed.");
        if (lifecycleAction && existingBinding?.terminalId !== pinnedSessionId) throw new SessionError("Terminal binding changed while queued; no lifecycle action performed.");
        const sessionId = pinnedSessionId;
        if (sessionAction && sessionId && !hostAction && !stoppedStatus) validateChannelTarget(channelId, sessionId, capturedGeneration);
        if (attachSessionId && capturedGeneration && getSession(attachSessionId)?.generation !== capturedGeneration) {
          throw new SessionError("The tab's sharing changed while attach was queued. Choose its current session explicitly.");
        }
        audit(stateDir, { id: interaction.id, user: interaction.user.id, action, subcommand, sessionId, phase: "accepted", inputLength: text?.length });
        let content: string;
        const terminal = isTargetAction && sessionId && !hostAction && !stoppedStatus ? getTerminal(sessionId) : undefined;
        const targetSession = sessionId ? getSession(sessionId) : undefined;
        if (action === "notify") {
          if (subcommand === "on") {
            const binding = await notifications.enable(channelId, interaction.options.getString("thread", true), interaction.options.getInteger("lines") ?? 60);
            content = `Notification enabled for Codex thread ${binding.threadId}. Future completed turns send the last ${binding.lines} terminal lines here; long output is a .txt attachment. No history is replayed. If Codex changes thread, enable /notify again with its new Session UUID.`;
          } else if (subcommand === "off") {
            notifications.disable(channelId); content = "Completion notification disabled for this channel.";
          } else content = notifications.status(channelId);
        } else if (action === "setup") {
          const selected = interaction.options.getChannel("orchestrator") ?? interaction.channel;
          if (!textChannel(selected)) throw new SessionError("The orchestrator must be a guild text channel.");
          guildSetups.set({ guildId: config.guildId, ownerId: config.ownerId, orchestratorChannelId: selected.id, version: 1, updatedAt: Date.now() });
          content = `Operator channel set to <#${selected.id}>. Use /machine add here to register a host.`;
        } else if (action === "machine") {
          const guild = interaction.guild;
          if (!guild) throw new SessionError("Use this command inside the configured Discord server.");
          const hostId = interaction.options.getString("machine", false) ?? "";
          if (subcommand === "pair") {
            if (!process.env.REMOTE_OPERATOR_AGENT_PORT || !process.env.REMOTE_OPERATOR_AGENT_URL) throw new SessionError("Configure the coordinator listener and REMOTE_OPERATOR_AGENT_URL before pairing.");
            const url = coordinatorUrl(process.env.REMOTE_OPERATOR_AGENT_URL).origin;
            content = `On the target Windows/Linux machine run npm run agent:pair.\nCoordinator: ${url}\nGuild: ${config.guildId}\nOwner: ${config.ownerId}\nOne-time code (5 minutes): ${agentHub.issuePair()}\nKeep this code private. Then use /machine add with the enrolled agent ID.`;
          } else if (subcommand === "revoke") {
            if (!interaction.options.getBoolean("confirm", true)) throw new SessionError("Use confirm:true to revoke this agent.");
            agentHub.revoke(hostId);
            const index = hostTargets.findIndex(target => target.id === hostId);
            if (index >= 0) hostTargets.splice(index, 1);
            hostExecutors.delete(hostId);
            content = "Agent access revoked. Its terminals remain on the machine; no pending commands will be replayed.";
          } else if (subcommand === "list") {
            const hostRows = await Promise.all(hostTargets.map(async target => {
              try {
                await probeHost(target.id, target.cwd);
                return `✅ ${hostTargetConnection(target)} · reachable`;
              } catch (error) {
                const detail = error instanceof SessionError ? error.message : "probe failed";
                return `❌ ${hostTargetConnection(target)} · unavailable · ${redact(detail, secrets).slice(0, 180)}`;
              }
            }));
            const rows = await Promise.all(categoryBindings.list(guild.id).map(async binding => {
              const found = await guild.channels.fetch(binding.categoryId).catch(() => null);
              const label = categoryChannel(found) ? found.name : (binding.label ?? binding.hostId);
              return `<#${binding.categoryId}> · ${label} → ${binding.hostId} · ${binding.defaultCwd}`;
            }));
            content = `Configured host profiles:\n${hostRows.join("\n")}\n\nRegistered project categories:\n${rows.length ? rows.join("\n") : "(none — use /machine add)"}`;
          } else if (subcommand === "remove") {
            const categoryOption = interaction.options.getChannel("category");
            let existing: CategoryBindingRecord | undefined;
            if (categoryChannel(categoryOption)) {
              existing = categoryBindings.get(categoryOption.id);
              if (existing && existing.guildId !== guild.id) existing = undefined;
            } else {
              const matches = categoryBindings.list(guild.id).filter(binding => binding.hostId === hostId);
              if (matches.length > 1) throw new SessionError("This host has multiple project profiles; choose the category option when removing one.");
              existing = matches[0];
            }
            if (!existing) throw new SessionError(categoryChannel(categoryOption) ? "That category is not registered in this guild." : `Machine ${hostId} is not registered in this guild.`);
            categoryBindings.remove(existing.categoryId);
            for (const binding of channelBindings.list(guild.id).filter(item => item.categoryId === existing.categoryId)) {
              channelBindings.set({ ...binding, status: "orphaned", error: "Machine category was unbound.", updatedAt: Date.now() });
            }
            content = `Unbound <#${existing.categoryId}> from ${hostId}. Its remote terminals were left running.`;
          } else {
            const cwd = interaction.options.getString("cwd") ?? hostTargets.find(target => target.id === hostId)?.cwd ?? root;
            const target = hostTargets.find(candidate => candidate.id === hostId);
            if (!target) throw new SessionError(`Machine ${hostId} is not configured in the local host registry.`);
            const requestedName = interaction.options.getString("name")?.trim();
            const cwdLeaf = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "root";
            const profileName = categoryDisplayName(requestedName || `${target.label} · ${cwdLeaf}`, target.id);
            const categoryOption = interaction.options.getChannel("category");
            if (subcommand === "bind") {
              if (!categoryChannel(categoryOption)) throw new SessionError("Choose an existing Discord category.");
              const record = await bindCategory(guild, categoryOption, hostId, cwd, categoryOption.createdTimestamp ?? Date.now(), categoryOption.name);
              content = `Bound <#${record.categoryId}> to ${hostTargetConnection(target)}. New child text channels will provision terminals automatically.`;
            } else if (subcommand === "add") {
              await probeHost(hostId, cwd);
              let category: CategoryChannel | undefined;
              const existing = categoryBindings.findByHostAndCwd(guild.id, hostId, cwd);
              if (existing) {
                const found = await guild.channels.fetch(existing.categoryId).catch(() => null);
                if (categoryChannel(found)) category = found;
                else categoryBindings.remove(existing.categoryId);
              }
              if (!category) {
                await requireCategoryPermissions(guild);
                const created = await guild.channels.create({
                  name: profileName,
                  type: ChannelType.GuildCategory,
                  permissionOverwrites: [
                    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
                    ...trustedDiscordUserIds(config).map(id => ({ id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.UseApplicationCommands] })),
                    { id: client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                  ],
                });
                if (!categoryChannel(created)) throw new SessionError("Discord did not create a category channel.");
                category = created;
              } else if (requestedName && category.name !== profileName) {
                await category.setName(profileName);
              }
              const record = await bindCategory(guild, category, hostId, cwd, category.createdTimestamp ?? Date.now(), category.name);
              content = `Machine profile ready: <#${record.categoryId}> · ${record.label ?? profileName} → ${hostTargetConnection(target)}. Create a child channel there, or use /terminal create-channel.`;
            } else throw new SessionError("Use /machine add, /machine list, /machine bind or /machine remove.");
          }
        } else if (action === "terminal" && (subcommand === "stop" || subcommand === "close")) {
          if (capturedBinding?.provider === "vscode-agent" || capturedBinding?.provider === "vscode") {
            throw new SessionError("This is a shared VS Code tab. Use Remote Operator: Stop Sharing Terminal in VS Code to revoke access without stopping its process. Deleting its Discord channel also leaves the process running.");
          }
          categoryForChannel(channelId, parentIdOf(interaction.channel));
          const currentChannel = interaction.channel;
          if (!textChannel(currentChannel)) throw new SessionError("Use this in a managed text channel.");
          if (subcommand === "close" && !currentChannel.permissionsFor(client.user!)?.has(PermissionFlagsBits.ManageChannels)) throw new SessionError("Bot needs Manage Channels here before closing; terminal was left running.");
          const result = await terminalLifecycle({
            action: subcommand, confirm: confirmLifecycle, channelId,
            parentId: parentIdOf(currentChannel), protectedChannel: orchestratorAllowed(channelId) || config.channelId === channelId,
            bindings: channelBindings, selections: channelSelections,
            terminal: sessionId ? managed.get(sessionId) : undefined, stop: stopManagedSession,
            beforeDelete: async () => { await interaction.editReply({ content: "Terminal stopped. Deleting this terminal channel; operator/category setup will remain." }); },
            deleteChannel: async () => { await currentChannel.delete("Trusted user requested terminal close"); },
          });
          if (result.deleted) {
            audit(stateDir, { id: interaction.id, action, subcommand, sessionId, phase: "completed", channelDeleted: true });
            return;
          }
          content = `${result.alreadyStopped ? "Terminal was already stopped" : "Terminal stopped"}. The channel was kept; use /terminal close confirm:true to delete it, or create another terminal channel.`;
        } else if (action === "terminal") {
          if (subcommand !== "create-channel" && subcommand !== "attach") throw new SessionError("Use /terminal create-channel or /terminal attach.");
          const guild = interaction.guild;
          const category = interaction.options.getChannel("category");
          if (!guild || !categoryChannel(category)) throw new SessionError("Choose a registered machine category.");
          const record = categoryBindings.get(category.id);
          if (!record || record.guildId !== guild.id) throw new SessionError("That category is not registered. Use /machine add or /machine bind first.");
          if (subcommand === "attach") {
            const attached = await attachManagedSession(guild, category, record, attachSessionId!, interaction.options.getString("name"), capturedGeneration, interaction.createdTimestamp + 60_000);
            rememberChannelDirectory(attached.id);
            await interaction.editReply({ content: `Attached existing terminal to <#${attached.id}>. No new process was created.` });
            audit(stateDir, { id: interaction.id, action, subcommand, sessionId: attachSessionId, phase: "completed" });
            return;
          }
          const platform = hostPlatform(configuredHostById(hostTargets, record.hostId));
          const requestedCwd = interaction.options.getString("cwd");
          const cwd = resolveDirectoryChoice({ guildId: config.guildId, hostId: record.hostId, platform,
            recent: requestedCwd?.startsWith("cwd-ref:") ? directoryHistory.list(config.guildId, record.hostId, platform) : [],
            defaultCwd: record.defaultCwd, value: requestedCwd });
          const created = await createManagedChannel(guild, category, record, interaction.options.getString("name"), cwd, interaction.createdTimestamp + 60_000);
          const binding = channelBindings.get(created.id);
          if (binding?.status === "ready") rememberChannelDirectory(created.id);
          content = binding?.status === "ready" && binding.terminalId
            ? `Created <#${created.id}> and provisioned terminal \`${binding.terminalId}\` on ${record.hostId} in \`${binding.cwd}\`.`
            : `Created <#${created.id}> but provisioning is ${binding?.status ?? "pending"}; inspect that channel for details.`;
        } else if (action === "sessions") {
          const machine = interaction.options.getString("machine");
          if (machine) configuredHostById(hostTargets, machine);
          const discovered = await inventory(machine ?? undefined);
          content = "Discovered terminals (machine · folder · terminal · provider · short ID):\n"
            + redact(discovered.slice(0, 12).map(s => sessionListLine(s, !s.reachable ? "unreachable" : s.shared ? (s.alive ? "shared" : "shared, closed") : "not shared")).join("\n"), secrets).slice(0, 1650)
            + (discovered.length > 12 ? `\nShowing 12/${discovered.length}; /terminal attach can search by folder or name.` : "");
        }
        else if (action === "output") {
          if (!targetSession) throw new SessionError("Selected terminal is no longer available; use /terminal attach in the operator channel.");
          content = formatOutput(await terminal!.output(interaction.options.getInteger("lines") ?? 30), secrets, sessionReference(targetSession));
        } else if (action === "status") {
          if (stoppedStatus) {
            await interaction.editReply({ content: "Terminal is stopped. The channel is retained; /terminal close confirm:true deletes it, or create another terminal channel." });
            audit(stateDir, { id: interaction.id, action, phase: "completed", status: "stopped" });
            return;
          }
          if (!targetSession) throw new SessionError("Selected terminal is no longer available; use /terminal attach in the operator channel.");
          content = `Session: ${sessionReference(targetSession)}\nVerified provider state:\n` + redact(await terminal!.status(), secrets);
        } else if (action === "run" || action === "gpu") {
          const executor = capturedHostBinding ? hostExecutors.get(capturedHostBinding.hostId) : getExecutor(sessionId!);
          if (!executor) throw new SessionError("This machine is no longer configured.");
          const commandToRun = action === "gpu" ? "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits" : command!;
          const result = await executor.run(commandToRun, timeoutSeconds * 1000, capturedHostBinding?.cwd ?? targetSession?.cwd ?? undefined);
          content = `Target: ${targetSession ? sessionReference(targetSession) : executor.target.label}\nCommand: ${action === "gpu" ? "nvidia-smi (fixed GPU query)" : commandToRun}\n` + redact(formatHostResult(result), secrets).slice(0, 1750);
        } else if (action === "key") {
          if (!key) throw new SessionError("Choose a supported key.");
          await terminal!.pressKey(key);
          content = `Key ${key} handed to ${targetSession ? sessionReference(targetSession) : sessionId}. Inspect /output to verify the application response.`;
        } else {
          const status = await terminal!.status();
          if (/\bdead=1\b|\balive=false\b/.test(status)) throw new Error("Selected terminal has exited; choose a live session with /sessions.");
          if (boundSessionId(channelId, parentIdOf(interaction.channel)) !== sessionId) throw new SessionError("Channel target changed before submit; no input was sent.");
          validateChannelTarget(channelId, sessionId!, capturedGeneration);
          if (action === "send") {
            notifications.pauseForInput(sessionId!, text!);
            await terminal!.send(text!, interaction.createdTimestamp + 60_000);
          }
          else await terminal!.interrupt();
          content = `${action === "send" ? "Input and submit key handed to" : "Ctrl-C handed to"} ${targetSession ? sessionReference(targetSession) : sessionId}. The running app's receipt is not verified; use /output to inspect it.`;
        }
        audit(stateDir, { id: interaction.id, action, subcommand, sessionId, phase: "completed" });
        await interaction.editReply({ content: fitDiscordMessage(content), allowedMentions: { parse: [] } });
      });
      await task;
    } catch (error) {
      const detail = error instanceof Error ? redact(error.message, secrets).slice(0, 300) : "unknown error";
      console.error(`Terminal interaction failed; action is not retried automatically: ${detail}`);
      const content = error instanceof SessionError ? error.message : "Request failed. It may have partially completed; inspect /output before retrying.";
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: redact(content, secrets).slice(0, 1800) });
        else await interaction.reply({ content: redact(content, secrets).slice(0, 1800), flags: MessageFlags.Ephemeral });
      } catch { /* Reconnect does not replay actions or responses. */ }
    }
  });

  client.once(Events.ClientReady, async ready => {
    try {
      const invite = `https://discord.com/oauth2/authorize?client_id=${ready.user.id}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}&guild_id=${config.guildId}&disable_guild_select=true`;
      console.log(`Bot authenticated. Install link (if needed): ${invite}`);
      const guild = ready.guilds.cache.get(config.guildId);
      if (!guild) {
        console.error("Bot is not in DISCORD_GUILD_ID. Install using the link, then restart the bridge.");
        await client.destroy();
        process.exitCode = 1;
        return;
      }
      const installedCommands = await ready.application.commands.fetch({ guildId: config.guildId });
      for (const definition of commandDefinitions) {
        const data = JSON.parse(JSON.stringify(definition.toJSON()));
        const existing = installedCommands.find(candidate => candidate.name === data.name && candidate.type === ApplicationCommandType.ChatInput);
        if (existing && !existing.equals(data, true)) await ready.application.commands.edit(existing.id, data, config.guildId);
        else if (existing) continue;
        else await ready.application.commands.create(data, config.guildId);
      }
      // Delete only the two superseded commands owned by this bridge.
      for (const obsolete of installedCommands.values()) {
        if (obsolete.type === ApplicationCommandType.ChatInput && ["select", "new"].includes(obsolete.name)) {
          await ready.application.commands.delete(obsolete.id, config.guildId);
        }
      }
      if (!existsSync(directoryHistory.file)) {
        // A ready attachment may have failed while parenting. Only actual
        // children of the original registered machine seed this first upgrade.
        const channels = await guild.channels.fetch();
        for (const binding of channelBindings.list(config.guildId).sort((a, b) => a.updatedAt - b.updatedAt)) {
          const channel = channels.get(binding.channelId), category = categoryBindings.get(binding.categoryId);
          if (!textChannel(channel) || channel.parentId !== binding.categoryId || !category
            || category.guildId !== config.guildId || category.hostId !== binding.hostId) continue;
          rememberChannelDirectory(binding.channelId);
        }
        directoryHistory.initialize();
      }
      registered = true;
      void notifications.start().catch(() => console.error("Notification reader startup failed; inspect /notify status. No history replayed."));
      healthState = "ready";
      health();
      console.log("READY: /setup, /machine, /terminal plus terminal status/key commands. Configured trusted users only.");
      console.log(messageContentEnabled
        ? "Normal messages in a provisioned terminal channel are submitted as one terminal line."
        : "Normal-message forwarding is disabled; set DISCORD_MESSAGE_CONTENT_INTENT=true after enabling Message Content Intent in the Discord developer portal.");
      await reconcileChannels(guild);
    } catch {
      console.error("Could not register slash commands. Check bot install, server ID, permissions and application-command scope.");
      await client.destroy();
      process.exitCode = 1;
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { notifications.close(); healthState = "stopping"; health(); void client.destroy().finally(() => process.exit(0)); });
  }
  await client.login(config.token);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "";
  console.error(message.startsWith("Set ") ? message : "Bridge startup failed. Check tmux, local state, credentials, and network access.");
  process.exitCode = 1;
});
