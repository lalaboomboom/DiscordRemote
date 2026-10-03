# DiscordRemote project context

DiscordRemote is a self-hosted Discord interface for terminal control.
One coordinator runs the bot for one configured Discord guild.
The owner and explicit trusted users can control registered machines.
Each Discord category identifies a machine. Each child channel binds one terminal.

Supported providers:

- Linux tmux, local or through a configured SSH connection.
- Windows ConPTY, local or through an enrolled agent.
- Explicitly shared VS Code tabs, local or through an enrolled agent.

Keep two terminal setup flows: create a new shell, or attach an existing supported session.
A new terminal can use a folder different from the category default.
Remember four recent folders per guild and physical machine.
Existing VS Code tabs require a Share grant. Discovery is not authorization.
An ordinary message submits text and one Enter to the bound application.
Named keys, output, diagnostics and lifecycle actions use slash commands.

The coordinator's recorded directory is the default for independent diagnostics and file staging.
It does not follow interactive shell environment changes.
Opt-in Codex notifications use an explicit native thread ID and verified completion events.
A completed Codex reply is not evidence that training has finished.

Use stable machine/terminal/provider/generation identities and request deadlines.
Do not redirect stale input or replay uncertain actions after reconnect.
Keep all credentials and runtime state local and ignored by Git.
The public repository contains the maintained product and its relevant tests.
Historical agent SDK experiments and private deployment records are outside this repository.
