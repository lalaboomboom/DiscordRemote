# Troubleshooting

Inspect the target before retrying an uncertain input.
DiscordRemote does not replay terminal input automatically.

## The bot is offline

1. Run `npm run discord:status` on the coordinator.
2. Read `.discord-bridge/bridge.log` locally.
3. Run `npm run discord:check`.
4. Run `npm run discord:doctor`.

Check the token, configured server ID, and bot membership.
Only one coordinator may use that token and runtime state.
The managed Linux launcher also needs tmux in its executable path.
Set `TMUX_BIN` to an absolute executable path if necessary.
The managed launcher uses the Node executable that runs the control command.
If you use a version manager, activate Node before you run `npm run discord:up`.
Do not kill the tmux server to restart the bot.

## Commands are missing or stale

1. Confirm that you installed the correct application in the configured server.
2. Confirm that the running coordinator uses the intended checkout.
3. Stop only that coordinator.
4. Build the intended source.
5. Start the coordinator again.

Building alone does not update a running bot.
The public command tree has 12 commands.
`/select` and `/new` are not supported.
The operator uses `/terminal create-channel` or `/terminal attach`.
Existing saved selections do not authorize operator input.

## Normal messages do nothing

1. Enable **Message Content Intent** on the application's **Bot** page.
2. Set `DISCORD_MESSAGE_CONTENT_INTENT=true` in the coordinator configuration.
3. Restart only the coordinator.
4. Send the message in a ready bound terminal channel.

Operator messages do not control terminals.
Slash commands can work without ordinary-message forwarding.
See [Discord's intent documentation](https://docs.discord.com/developers/events/gateway#message-content-intent).
File attachment prompts also require the intent.

## Category creation reports missing permissions

1. Check the bot's effective permissions in the target server.
2. Reauthorize it with the README install URL if needed.
3. Check category-specific permission overwrites.
4. Check the bot role's position in the server role hierarchy.

The bot needs View Channels, Send Messages, Manage Channels, and Manage Roles for the management flow.
Private terminal channels must also allow trusted controllers to use application commands.
A public category cannot safely auto-provision arbitrary members' processes.

## A machine is not configured

1. Run `/machine list` in the operator channel.
2. Select an exact registered host ID.
3. Check `.remote-operator/hosts.json` for an SSH host.
4. Check the enrollment and route for an agent host.

A category name is only a display label.
An SSH profile belongs to the configured Linux host, not another machine with a similar label.
Do not enter SSH passwords or keys in Discord.
See [SSH host setup](SSH-HOSTS.md).

## Terminal creation fails

1. Check that the directory is absolute for the target OS.
2. Check that the directory exists on the physical target machine.
3. Check the target account's directory access.
4. Read the failed channel's status before retrying.

Linux paths start with `/`.
Windows paths use an absolute drive or UNC path.
Relative paths and `~` are not accepted.
DiscordRemote does not create project directories.
Discord channel creation and terminal provisioning are not one atomic operation.
An ambiguous failure must not produce a second terminal on an automatic retry.

Recent directories appear only after successful authorized create/attach operations.
Suggestions belong to the selected physical machine.
A long-directory reference can expire after history or scope changes.
Choose a current suggestion or type its full absolute path.

## The Windows or Linux agent is offline

1. Check that the coordinator hub is running.
2. Check that the target agent client is running.
3. Check that its SSH tunnel or HTTPS route is running.
4. Confirm that pairing used the correct URL and port.
5. Read the local agent log without sharing its credential file.

For the documented tunnel, the agent URL is `http://127.0.0.1:8788`.
The remote hub still listens on coordinator loopback port 8787.
The default password-tunnel local port is 8787 unless `REMOTE_OPERATOR_TUNNEL_PORT` overrides it.
VPN reachability does not prove authenticated agent polling.
Restarting an agent does not restore processes lost during reboot or logoff.
See [agent deployment](AGENT-DEPLOYMENT.md).

## The password tunnel fails

1. Start it from the directory containing `.env.coordinator`.
2. Check the SSH address, account, port, and local password.
3. Compare the server fingerprint with an independently trusted value.
4. Check whether the selected local port is already occupied.

Explicit IP routes with a verified fingerprint avoid OpenSSH alias lookup.
Aliases still use OpenSSH configuration lookup.
There is no fallback to unverified host keys.
Do not disable host verification to fix a route error.

## A VS Code tab is missing or unshared

1. Confirm that the extension is installed on the UI machine.
2. Confirm that the target window loaded the extension.
3. Open a trusted workspace when appropriate.
4. Run **Remote Operator: Share Terminal with Discord** in that window.
5. Select the intended tab.
6. Check `/sessions` again.

An installed package is not proof of a loaded extension version.
Do not reload a window that has active work only to troubleshoot sharing.
Unknown Remote-SSH hosts, WSL, and containers cannot be attached through this flow.
Standalone consoles outside VS Code do not automatically appear.

## Shared-tab output capture fails

1. Keep VS Code and its Remote-SSH connection open.
2. Avoid concurrent terminal selection and clipboard operations.
3. Check that the original tab still exists and remains shared.

Snapshot capture temporarily uses terminal selection and clipboard text.
It can change focus. It does not preserve rich clipboard formats.
Old clipboard contents are never accepted as replacement terminal output.
Shared tabs do not provide a separate continuous PTY log.
Use managed tmux or ConPTY for new sessions that need independent capture.

## Text appears in Codex but the result is unclear

1. Read `/output` before sending anything again.
2. Check the loaded provider's status and version.
3. Confirm that the tab is shared and its original generation is current.

Normal messages and `/send` submit text followed by one paced Enter.
The foreground application decides how to handle that input.
A provider receipt does not prove that Codex accepted or completed a turn.
Do not add automatic Enter retries to an uncertain prompt.
Codex's `/resume` can open a menu instead of immediately starting a turn.
Use `/key` to navigate that menu deliberately.
New named keys can require a newer extension or native supervisor capability.
Updating only the agent does not update a running supervisor.

## Completion notifications are silent or paused

1. Read `/notify status` in the bound terminal channel.
2. Submit `/send text:/status` to the running Codex CLI.
3. Read its exact Session UUID with `/output`.
4. Bind that UUID with `/notify on thread:<UUID> lines:60`.

Notifications start at the current source position. Past completions are not replayed.
Only supported native completion events with a nonempty final answer can trigger a snapshot.
Idle output, an echoed prompt, or a running training process does not qualify.
The watcher requires the exact machine, terminal generation, directory, and thread.
Changing the target or source identity can pause it.
The native JSONL format is version-dependent.
Disable notifications before a local thread switch.
Bind the new thread explicitly after the switch.

## A stopped terminal or old channel will not reconnect

1. Read the bound channel's `/status`.
2. Check whether the original process still exists.
3. Renew a re-shared VS Code tab with explicit `/terminal attach`.
4. Create a new terminal channel if the old process ended.

Bindings never silently switch to another tab or same-named process.
Moving a channel out of its bound category blocks controls.
Stopped managed terminals are not automatically reprovisioned after restart.
`/terminal close confirm:true` can delete a stopped managed channel.
Deleting a shared-tab channel does not kill its external process.

## Share a useful bug report

1. Record the operating systems and loaded provider versions.
2. Record the command and its observed result.
3. Include a minimal redacted output excerpt.
4. Remove credentials, enrollment files, private paths, and personal identifiers.

Report sensitive issues through [the security guidance](../SECURITY.md).
