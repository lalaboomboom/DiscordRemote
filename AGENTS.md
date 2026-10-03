# Development instructions

Read CONTEXT.md before you change the project.
Keep the Discord command tree and provider protocols consistent across Windows and Linux.
Use the native approval controls of your coding agent.
Do not add a second approval procedure for development commands.

Run `npm run typecheck`, `npm test` and `npm run vscode:package` for relevant changes.
The default tests do not connect to a production Discord bot or use real credentials.
Live provider tests are separate commands. Use disposable sessions for those tests.
Do not restart a user terminal, native supervisor or busy VS Code window to run a test.

Keep secrets, host registries, logs, enrollment and deployment state out of Git.
Use generic fixture identities and paths in source, tests and examples.
Never replay uncertain terminal input after a timeout or reconnect.
Preserve the original machine, terminal, provider and sharing-generation checks.

Use short status updates. Report changes, checks and material limitations.
