# Add a Linux SSH host

Run these steps on the coordinator machine.
Use an SSH account that can start tmux on the target machine.
Remote Windows machines use an enrolled agent. Do not add them as SSH hosts.

## Use key authentication

1. Install OpenSSH on the coordinator.
2. Install tmux and Python 3 on the Linux target.
3. Set up SSH key authentication for the target account.
4. Get the target host fingerprint from a separate trusted source.
5. Verify that fingerprint before you add the host to `known_hosts`.
6. Add the edited [SSH example](../examples/ssh-config) to your SSH config.

On Linux, the SSH config is `~/.ssh/config`.
On Windows, the SSH config is `$HOME\.ssh\config`.
Use your actual host, user, port and key path.
Keep the host alias `gpu-server` if you use the examples below.

Test noninteractive access:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes gpu-server "pwd; tmux -V; python3 --version"
```

The command must finish without a password or host-trust prompt.
Do not disable host-key checks to make the command pass.

## Set the host registry

With no registry, the coordinator has a `local` profile in its repository folder.
To add SSH hosts, create `.remote-operator/hosts.json` on the coordinator.
Copy the example for the coordinator's operating system:

```sh
mkdir -p .remote-operator
cp examples/hosts.linux.json .remote-operator/hosts.json
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force .remote-operator
Copy-Item examples/hosts.windows.json .remote-operator/hosts.json
```

1. Edit the copied file.
2. Set each `cwd` to an existing folder on that profile's machine.
3. Set `host`, `user` and `port` to the target connection.
4. Keep each `id` unique and stable.
5. Restart only the coordinator after you save the registry.
6. Run `/machine add machine:gpu-server` in the Discord operator channel.
7. Create or attach a terminal under the new category.

`host` can be the verified SSH alias from your SSH config.
`id` is the stable Discord routing key. `label` is only a display name.
Changing a label does not change the route.
Do not reuse a removed host ID for a different machine.

A category supplies the default folder for new terminals.
Use `cwd` in `/terminal create-channel` to choose a different existing folder.
`/terminal attach` takes the existing terminal's folder.
The category must identify the machine that runs that process.

## Optional password authentication

Keep the password on the coordinator. Do not send it to Discord.

1. Copy `.env.ssh.example` to `.env.ssh`.
2. Set `GPU_SERVER_SSH_PASSWORD` in the copied file.
3. Add `"passwordEnv": "GPU_SERVER_SSH_PASSWORD"` to the SSH host record.
4. Add `hostKeySha256` with the independently verified `SHA256:` fingerprint.
5. Restart only the coordinator.

The password value does not belong in the JSON registry.
The `ssh2` transport verifies host trust before password authentication.
Use a verified literal host address for a direct pinned connection.
An SSH alias can use the OpenSSH config lookup.

`.env.coordinator` has a different purpose: an agent's tunnel to the coordinator.
Do not copy a GPU server's password or fingerprint into that file.
