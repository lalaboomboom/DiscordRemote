# Connect a Windows or Linux agent

One Linux coordinator runs the Discord bot.
Each enrolled computer runs an outbound agent client.
Windows terminals use a persistent ConPTY supervisor. Linux terminals use tmux.
The agent does not need the Discord token.

## Use an agent bundle

1. Install Node.js 22 or newer.
2. Obtain an agent bundle for your target OS and architecture.
3. Extract it into a stable local directory.
4. Open a terminal in the directory containing `package.json`.
5. Select an existing default project directory.

The bundle contains compiled application files and platform dependencies.
It does not require cloning, `npm ci`, or a build step.
It includes `.env.coordinator.example` for the password tunnel.
Continue with **Choose a route** below.
See [the main setup guide](https://github.com/lalaboomboom/DiscordRemote/blob/main/README.md) for coordinator installation.

## Prepare the target from source

1. Install Node.js 22 or newer.
2. Clone DiscordRemote on the target computer.
3. Enter the checkout directory.
4. Run `npm ci`.
5. Run `npm run discord:build`.
6. Select an existing default project directory.

Linux targets need tmux, Python 3, make, and g++.
Windows installations use native `node-pty` binaries when available.
If native installation fails, install Python and Visual Studio Build Tools with **Desktop development with C++**.
Do not copy another platform's `node_modules` directory.

## Choose a route

| Route | Requirements |
| --- | --- |
| Verified SSH tunnel | A reachable coordinator SSH service and a verified server identity. |
| HTTPS | A reachable private HTTPS endpoint with a certificate trusted by the agent. |

Machines do not need the same local network.
They do need a working authenticated route.
A private VPN can supply network reachability. It does not replace SSH/TLS verification.
The software does not configure SSH accounts, firewalls, VPNs, or startup services.

## Configure the coordinator for an SSH tunnel

1. Uncomment the three agent settings in the coordinator's `.env.discord`.
2. Set their values as shown below.

   ```dotenv
   REMOTE_OPERATOR_AGENT_PORT=8787
   REMOTE_OPERATOR_AGENT_BIND=127.0.0.1
   REMOTE_OPERATOR_AGENT_URL=http://127.0.0.1:8788
   ```

3. Restart only the coordinator.
4. Check `npm run discord:doctor` on the coordinator.

The hub listens on coordinator loopback port 8787.
The advertised URL above refers to the agent computer's tunnel listener on port 8788.
Loopback HTTP is accepted only for this encrypted tunnel route.
Do not expose the plain HTTP hub on a public interface.

### Key-authenticated SSH tunnel

1. Configure your coordinator SSH alias in the agent computer's OpenSSH config.

   ```sshconfig
   Host coordinator
       HostName 192.0.2.10
       User alice
       Port 22
       IdentityFile ~/.ssh/id_ed25519
       IdentitiesOnly yes
       StrictHostKeyChecking yes
   ```

2. Obtain the coordinator fingerprint through an independent trusted channel.
3. Verify that fingerprint before accepting its host key.
4. Start the tunnel in a separate terminal.

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -L 127.0.0.1:8788:127.0.0.1:8787 coordinator
   ```

5. Keep that tunnel process running.

Use [the SSH configuration example](https://github.com/lalaboomboom/DiscordRemote/blob/main/examples/ssh-config) as a template.
The `coordinator` alias must identify your actual coordinator account and address.
This native SSH command does not provide the application's reconnect loop.

### Password-authenticated SSH tunnel

1. Copy `.env.coordinator.example` to `.env.coordinator` on the agent computer.
2. Fill its SSH settings locally.

   ```dotenv
   SSH_HOST=192.0.2.10
   SSH_PORT=22
   SSH_USER=alice
   SSH_PASSWORD=YOUR_COORDINATOR_SSH_PASSWORD
   SSH_HOST_KEY_SHA256=SHA256:YOUR_VERIFIED_FINGERPRINT
   ```

3. Replace the example address and account with your coordinator details.
4. Obtain the fingerprint through an independent trusted channel.
5. Save the complete verified fingerprint in `SSH_HOST_KEY_SHA256`.
6. Set the local tunnel port in PowerShell.

   ```powershell
   $env:REMOTE_OPERATOR_TUNNEL_PORT = '8788'
   ```

7. Start the tunnel from the agent checkout.

   ```powershell
   npm run agent:tunnel
   ```

8. Keep that process running.

On Linux, set the local port before running the same tunnel command:

```sh
export REMOTE_OPERATOR_TUNNEL_PORT=8788
npm run agent:tunnel
```

The example address is reserved documentation data, not a working server.
The tunnel reads `.env.coordinator` from its working directory.
`REMOTE_OPERATOR_TUNNEL_PORT` is an environment variable, not a setting read from that file.
The remote destination remains coordinator loopback port 8787.

An explicit IP, user, port, and verified fingerprint use direct pinned SSH.
SSH aliases still require OpenSSH configuration lookup.
Host verification is never silently disabled.
The tunnel binds only local loopback and reconnects with bounded backoff.
It closes in-flight connections rather than replaying requests.

### HTTPS alternative

1. Provide a trusted private HTTPS endpoint for the coordinator hub.
2. Set `REMOTE_OPERATOR_AGENT_URL` to that endpoint on the coordinator.
3. Keep the hub on loopback behind your configured TLS reverse proxy.
4. Use the HTTPS URL during pairing.

Direct TLS also accepts `REMOTE_OPERATOR_TLS_KEY` and `REMOTE_OPERATOR_TLS_CERT` on the coordinator.
Both must reference existing certificate files.
`REMOTE_OPERATOR_AGENT_BIND` selects the listening interface.
Use an interface appropriate for your private deployment.
Do not disable agent certificate verification.

## Pair the agent

1. Run `/machine pair` in Discord's operator channel.
2. Run `npm run agent:pair` on the target computer.
3. Enter `http://127.0.0.1:8788` for the tunnel route.
4. Enter the one-time code from Discord.
5. Enter the expected Discord server ID.
6. Enter the configured owner user ID.
7. Enter an existing default project directory.
8. Check the displayed coordinator and scope.
9. Type `PAIR` to accept enrollment.
10. Run `npm run agent:start` in another terminal.

For HTTPS, enter its URL instead of the loopback address.
Pairing codes expire after five minutes and work once.
Coordinator restart expires unused codes.
The CLI reports an enrolled ID such as `agent-<16-hex-characters>`.
Keep the tunnel and agent running separately.

Enrollment is stored in `.remote-operator/agent/enrollment.json` by default.
`REMOTE_OPERATOR_AGENT_STATE` can select another local state directory.
Windows credentials use DPAPI for the current signed-in user.
Linux credentials use private mode-0600 files and mode-0700 directories.
Do not run two agent clients with the same enrollment.
Do not pair again only because the route temporarily disconnected.

## Create or attach a terminal

1. Run `/machine list` in Discord's operator channel.
2. Select the enrolled ID in `/machine add`.

   ```text
   /machine add machine:<agent-ID> name:Laptop cwd:C:\Projects\Demo
   ```

3. Create a terminal in its returned category.

   ```text
   /terminal create-channel category:Laptop name:shell cwd:C:\Projects\Demo
   ```

4. Open the returned terminal channel.
5. Send `Write-Output (21 * 2)` on Windows.
6. Read the result with `/output`.

For Linux, use an existing absolute path such as `/srv/projects/demo`.
Omit `cwd` to use the category's default directory.
Each child channel can record a different directory on the same physical machine.
Recent-directory suggestions contain four successful directories, plus a distinct default.
New folders are not automatically created.

For an existing VS Code tab:

1. Install the packaged extension on the agent computer's VS Code UI.
2. Confirm that the relevant window loaded the extension.
3. Run **Remote Operator: Share Terminal with Discord**.
4. Select the existing tab.
5. Find the tab with `/sessions` in Discord's operator channel.
6. Run `/terminal attach` with its session and physical machine category.

Attach preserves the process and records its reported directory.
The extension uses the agent's per-user local bridge locator.
`remoteOperator.bridgeDirectory` can override the local bridge directory.
It must reference the UI machine's state, not a remote server directory.
Remote-SSH tabs attach to their configured SSH server category.
The UI agent remains the input/output relay.
`/run`, `/gpu`, and native Codex event reads use the physical SSH host.
WSL and container tabs are unsupported.

## Reconnect, stop, and revoke

An agent reconnect preserves terminal identity when its supervisor or tmux server survives.
It never replays uncertain terminal input.
Stopping only the agent client does not stop those terminal processes.
Stopping only the coordinator also preserves saved bindings and managed terminals.

Windows reboot, user logoff, or supervisor failure can end ConPTY terminals.
Linux host reboot can end tmux sessions.
No automatic startup service is installed.
Restart the route and agent after reboot.
Check `/machine list` before using a bound terminal.
An online VPN alone does not prove that the agent is connected.

To revoke access:

```text
/machine revoke machine:<agent-ID> confirm:true
```

Revocation rejects new operations and queued requests.
An already delivered command can still finish.
Revocation does not terminate terminal processes.
Re-enrollment requires explicit state preservation and a new pairing code.

## Updates

1. Preserve the enrollment and terminal supervisor state.
2. Stop only the agent client.
3. Build the updated checkout for that platform.
4. Restart the agent client from the same state directory.
5. Check `/machine list` and `/status`.

Do not replace a running native supervisor while it owns active terminals.
An extension package update does not update a loaded VS Code extension host.
Wait for a safe window handoff before reloading.
See [troubleshooting](https://github.com/lalaboomboom/DiscordRemote/blob/main/docs/TROUBLESHOOTING.md) for identity, route, and provider failures.
