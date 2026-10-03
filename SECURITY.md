# Access and credentials

Run one coordinator under a machine account that you control.
The bot accepts its configured owner and explicit trusted users in one guild.
Commands use the permissions of the coordinator or target machine account.
The bot is not a sandbox for untrusted commands.

Keep machine categories private. Keep the operator channel outside those categories.
Install the bot with the permissions in the README. Do not grant Administrator.
Keep `.env.*`, SSH keys and all runtime folders out of Git.
Use the example files as templates. Do not put a bot token on an agent machine.

Agents use short-lived pairing codes and scoped local enrollment credentials.
The agent HTTP endpoint permits loopback HTTP for an encrypted SSH tunnel.
Use authenticated HTTPS for a non-loopback route.
Do not expose the loopback HTTP listener as an unauthenticated public service.
Verify the SSH host fingerprint through a separate trusted source before you connect.

Terminal snapshots can contain private output. Known configured secrets are redacted.
Redaction does not classify arbitrary files or recognize every application secret.
Check the channel's members before you display sensitive output.

# Report a defect

For a public report, include the version, operating system and steps to reproduce.
Remove tokens, passwords, enrollment, transcripts and private machine details from the report.
For a credential exposure, reset the affected credential before you share diagnostic output.
Do not post a working credential in a GitHub issue.
