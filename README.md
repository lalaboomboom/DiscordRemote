# DiscordRemote

Control your terminals from Discord with one self-hosted bot.

Create a terminal channel. Send a command. Read the output when needed.
Use the same channel for a shell or a running Codex CLI.

| Component | Purpose |
| --- | --- |
| Coordinator | Runs the Discord bot and keeps channel bindings. |
| Machine category | Identifies a physical machine and its default directory. |
| Terminal channel | Controls one exact terminal and records its own directory. |
| Agent | Connects a Windows or Linux machine to the coordinator. |
| VS Code extension | Shares selected existing terminal tabs through the local UI. |

The coordinator supports local Linux tmux, configured Linux SSH servers, and enrolled Windows/Linux agents.
Windows agents use ConPTY. Linux agents use tmux.
Agents connect outwards. They do not need a Discord token.

## Install the coordinator

Use a Linux machine that can stay online.

1. Install Node.js 22 or newer.
2. Install Git, tmux, Python 3, make, and g++.
3. Clone this repository.

   ```sh
   git clone https://github.com/lalaboomboom/DiscordRemote.git
   ```

4. Enter the repository.

   ```sh
   cd DiscordRemote
   ```

5. Install dependencies.

   ```sh
   npm ci
   ```

6. Build the application.

   ```sh
   npm run discord:build
   ```

## Configure Discord

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy its Application ID from **General Information**.
3. Generate its bot token on the **Bot** page.
4. Enable **Message Content Intent** under **Privileged Gateway Intents**.
5. Enable **Developer Mode** in Discord's **Advanced** user settings.
6. Copy your user ID with **Copy User ID**.
7. Copy your server ID with **Copy Server ID**.
8. Replace `YOUR_APPLICATION_ID` in this install URL.

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=268438544
   ```

9. Open the completed URL.
10. Authorize the bot in your server.

The URL requests View Channels, Send Messages, Manage Channels, and Manage Roles.
The bot checks effective permissions before category operations.
An Interactions Endpoint URL is not required for this Gateway-based bot.
See [Discord's setup guide](https://docs.discord.com/developers/quick-start/getting-started) for portal details.

11. Copy the configuration example.

    ```sh
    cp .env.discord.example .env.discord
    ```

12. Fill these values in `.env.discord`.

    ```dotenv
    DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
    DISCORD_OWNER_ID=YOUR_USER_ID
    DISCORD_GUILD_ID=YOUR_SERVER_ID
    DISCORD_MESSAGE_CONTENT_INTENT=true
    ```

13. Add trusted user IDs only if you want additional controllers.

    ```dotenv
    DISCORD_ALLOWED_USER_IDS=FIRST_USER_ID,SECOND_USER_ID
    ```

Trusted users can use all bot commands in the configured server and bound channels.
The owner ID still identifies the enrollment scope.
The list supports at most 32 users, including the owner.
Keep the token and configuration files private.

## Start the coordinator

1. Check the local configuration.

   ```sh
   npm run discord:check
   ```

2. Start the bot in the foreground.

   ```sh
   npm run discord:start
   ```

3. Wait for the ready message.

For managed startup, stop the foreground bot first.
Then run each command separately:

```sh
npm run discord:up
npm run discord:status
npm run discord:doctor
```

Do not start two coordinators with the same token or state directory.
`discord:doctor` checks connectivity. It does not submit terminal input.

## Create your first terminal

1. Create a private Discord text channel named `operator`.
2. Give the bot and your trusted users access to that channel.
3. Run `/setup` in `operator`.
4. Register the coordinator machine.

   ```text
   /machine add machine:local name:Workstation
   ```

5. Select the returned category in this command.

   ```text
   /terminal create-channel category:Workstation name:shell
   ```

6. Open the returned terminal channel.
7. Send a normal message containing `pwd`.
8. Read the result with `/output`.

Without a custom directory, the local category uses this checkout's repository directory.
Custom directories must already exist. DiscordRemote does not create project directories.
The terminal starts with the target machine's default shell.
You can launch `codex` inside that shell when Codex is installed and configured.

Each terminal can use a different directory within the same machine category:

```text
/terminal create-channel category:Workstation name:another-project cwd:/srv/projects/another
```

The optional `cwd` accepts an absolute target-OS path, up to 500 characters.
Autocomplete offers four recent successful directories for that machine, plus a distinct category default.
You can also type a new absolute path.
Long suggestions resolve to their complete paths; they are never truncated.

## Attach an existing terminal

1. Build the optional VS Code extension.

   ```sh
   npm run vscode:package
   ```

2. Install `.discord-bridge/remote-operator-terminal-0.1.7.vsix` with VS Code's **Install from VSIX** command.
3. Confirm that the target window loaded the extension.
4. Open the Command Palette in that window.
5. Run **Remote Operator: Share Terminal with Discord**.
6. Select the existing terminal tab.
7. Run `/sessions` in `operator`.
8. Attach the shared session to its physical machine category.

   ```text
   /terminal attach session:<shared-session> category:<machine-category> name:existing-terminal
   ```

Attach creates or reuses the Discord channel. It preserves the original process.
It records the terminal's reported directory. That directory need not match the category default.
Attach has no directory override.

The extension runs on the local UI machine, including in Remote-SSH windows.
A Remote-SSH tab belongs to its configured SSH server category, not the UI machine's category.
WSL, containers, unknown servers, and guessed remote workspace directories are refused.
See [SSH host setup](docs/SSH-HOSTS.md) and [agent setup](docs/AGENT-DEPLOYMENT.md).

VS Code must remain open. Remote-SSH connections must remain active.
Output capture can temporarily change focus and the clipboard's text.
It does not preserve rich clipboard formats or provide continuous PTY logs.
Untrusted workspaces do not activate the extension.
Do not reload a busy window only to activate a new extension version.

`/sessions` lists discovered terminals. Discovery does not grant access to unshared tabs.
Standalone consoles outside VS Code are not universally attachable.
Known managed sessions can also use `/terminal attach`.

## Add other machines

For a Linux SSH server:

1. Configure its SSH key and verified `known_hosts` entry.
2. Add its profile to `.remote-operator/hosts.json`.
3. Restart the coordinator.
4. Select its registered ID in `/machine add`.

Use [the SSH guide](docs/SSH-HOSTS.md) and [the Linux registry example](examples/hosts.linux.json).
SSH profiles currently target Linux servers.
Remote Windows requires an enrolled agent.

For another Windows or Linux computer, follow [agent deployment](docs/AGENT-DEPLOYMENT.md).
Keep its agent and verified tunnel or HTTPS route running.
The target computer does not run another Discord bot.

## Control the terminal

Normal messages submit one line and one Enter to the terminal channel's pinned session.
Text input is limited to 500 characters. Use text attachments for longer prompts in managed terminals.
A shell treats the message as a command. Codex treats it as a prompt.
Operator messages do not control a terminal.

| Command | Action |
| --- | --- |
| `/sessions` | Discover terminals and sharing state. |
| `/status` | Read the bound terminal's observed state. |
| `/output lines:60` | Read recent terminal output on demand. |
| `/send text:...` | Submit one line, up to 500 characters. |
| `/key key:...` | Send Enter, Escape, Tab, arrows, Ctrl-C, or supported Shift + Left. |
| `/interrupt` | Send Ctrl-C to the foreground program. |
| `/run command:...` | Run a separate bounded command on the physical machine. |
| `/gpu` | Run a fixed GPU diagnostic on that machine. |
| `/terminal stop confirm:true` | Stop a managed terminal and retain its channel. |
| `/terminal close confirm:true` | Stop a managed terminal and delete its channel. |

To use Codex's own slash commands:

1. Submit `/send text:/resume` in the terminal channel.
2. Read the menu with `/output`.
3. Move the selection with `/key key:down` or `/key key:up`.
4. Confirm your choice with `/key key:enter`.

`/send text:/status` similarly submits Codex's command, rather than DiscordRemote's `/status`.
Native approval menus require your explicit input. DiscordRemote does not automatically approve them.
Successful API delivery does not prove application completion. Inspect output before retrying an uncertain send.

`/run` and managed attachment inboxes use the directory recorded when the channel was created or attached.
They do not follow interactive `cd`, exported variables, or conda activation.
Changing directory in the same shared tab does not revoke its input, output, or key access.

For a shared VS Code tab, revoke access with **Remote Operator: Stop Sharing Terminal**.
Managed stop/close does not kill that external tab.
Re-sharing requires explicit attach to renew the channel's sharing generation.

## Send long prompts

1. Save the prompt as a text file.
2. Attach the file to a message in a managed terminal channel.
3. Put any additional instruction in the message caption.
4. Inspect the result with `/output`.

Managed tmux and ConPTY terminals accept up to four text attachments, each up to 4 MiB.
The bot saves them under the recorded directory's `.discord-bridge/inbox`.
It submits a short prompt that refers to those files.
Shared VS Code tabs do not support file attachments.
Files expire after 30 minutes by default.
`DISCORD_ATTACHMENT_TTL_MINUTES` accepts 1–1440 minutes.
A submitted prompt does not prove that Codex has finished reading its files.

## Enable Codex completion notifications

1. Submit `/send text:/status` in the Codex terminal channel.
2. Read the Codex Session UUID with `/output`.
3. Enable notifications for that exact UUID.

   ```text
   /notify on thread:<Session-UUID> lines:60
   ```

4. Check the subscription with `/notify status`.
5. Disable it with `/notify off` when needed.

Notifications default off. The line count accepts 50–70, with 60 as the default.
Future native Codex completions with a final answer trigger a recent terminal snapshot.
The watcher does not replay old completions or infer completion from idle output.
It pins the channel, physical machine, terminal generation, directory, and explicit Codex thread.
It does not detect the correct thread automatically.
Codex's native JSONL format is version-dependent, not a stable public API.

Snapshots can include prompts and tool output. Known secrets are redacted, but arbitrary private text can remain.
Mentions are disabled. Long snapshots use TXT attachments capped at 64 KiB.
A completed Codex reply does not mean training has finished.
Disable notifications before switching threads locally.
Bind the new UUID after the switch.
Changed targets, source identity, or ambiguous delivery can pause the watcher.

## Restart and recovery

Run each command separately:

```sh
npm run discord:down
npm run discord:up
npm run discord:status
```

Stopping only the coordinator preserves managed terminal processes and saved channel bindings.
Stopping only an agent preserves terminals when their supervisor or tmux server survives.
Uncertain input is never automatically replayed after reconnection.

Machine reboot, Windows logoff, or supervisor failure can end terminal processes.
Restart the agent and its tunnel after reboot.
Restart the coordinator after its host reboots.
No automatic startup service is installed.
Keep configuration, enrollment, and private runtime state during upgrades.
See [troubleshooting](docs/TROUBLESHOOTING.md) and [security](SECURITY.md).

## Development

```sh
npm run discord:typecheck
npm run test:discord
```

Live PTY and agent tests are optional. They create disposable processes.
Run them explicitly on a test machine:

```sh
npm run test:pty
npm run test:agent
```

Writing style is inspired by [ASD-STE100 guidance](https://www.asd-ste100.org/STE_faq.html).
See [Rule 5](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf) for procedural sentence guidance.

Licensed under [MIT](LICENSE).
