import { createServer, Server, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";

export interface TunnelOptions {
  localPort: number;
  config: ssh2.ConnectConfig;
  log?: (message: string) => void;
  createClient?: () => ssh2.Client;
  createListener?: (accept: (socket: Socket) => void) => Server;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Keep one private listening port; reconnect SSH, never an in-flight request. */
export async function runReconnectingTunnel(options: TunnelOptions, signal: AbortSignal): Promise<void> {
  if (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535) throw new Error("Invalid local tunnel port.");
  if (signal.aborted) return;
  const log = options.log ?? (() => {});
  const fatal = new AbortController();
  const stopped = AbortSignal.any([signal, fatal.signal]);
  const sockets = new Set<Socket>();
  let active: ssh2.Client | undefined;
  let listenerError: Error | undefined;
  let failures = 0;
  const destroySockets = () => { for (const socket of sockets) socket.destroy(); sockets.clear(); };
  const listener = (options.createListener ?? createServer)(socket => {
    const connection = active;
    // Reject while offline instead of buffering commands until reconnect.
    if (!connection || stopped.aborted) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    try { connection.forwardOut("127.0.0.1", socket.remotePort || 0, "127.0.0.1", 8787, (error, stream) => {
      if (error || active !== connection || stopped.aborted || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
      socket.once("close", () => stream.destroy());
      socket.on("error", () => stream.destroy());
      stream.on("error", () => socket.destroy());
      stream.once("close", () => socket.destroy());
      socket.pipe(stream).pipe(socket);
    }); } catch { socket.destroy(); }
  });
  listener.on("error", error => { listenerError = error; fatal.abort(); });
  try {
    await new Promise<void>((done, reject) => {
      const failed = (error: Error) => { listener.off("listening", ready); reject(error); };
      const ready = () => { listener.off("error", failed); done(); };
      listener.once("error", failed); listener.once("listening", ready);
      listener.listen(options.localPort, "127.0.0.1");
    });
    while (!stopped.aborted) {
      await new Promise<void>(done => {
        const connection = (options.createClient ?? (() => new ssh2.Client()))();
        let completed = false;
        let errorLogged = false;
        const disconnect = () => {
          if (active === connection) { active = undefined; destroySockets(); }
        };
        const finish = () => {
          if (completed) return;
          completed = true; stopped.removeEventListener("abort", abort);
          disconnect(); done();
        };
        const abort = () => { disconnect(); connection.destroy(); finish(); };
        stopped.addEventListener("abort", abort, { once: true });
        connection.once("ready", () => {
          if (stopped.aborted) { abort(); return; }
          active = connection; failures = 0;
          log(`Verified SSH tunnel ready: http://127.0.0.1:${options.localPort}.`);
        });
        connection.on("error", () => {
          if (!errorLogged && !stopped.aborted) { errorLogged = true; log("Verified SSH connection failed; credentials hidden."); }
          disconnect(); connection.destroy();
        });
        connection.once("close", finish);
        try { connection.connect({ ...options.config, keepaliveInterval: 15_000, keepaliveCountMax: 3 }); }
        catch { connection.destroy(); finish(); }
      });
      if (stopped.aborted) break;
      const milliseconds = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      log(`SSH tunnel disconnected; retrying in ${milliseconds / 1000}s. In-flight requests are not replayed.`);
      try {
        await (options.wait ?? ((ms, abortSignal) => delay(ms, undefined, { signal: abortSignal })))(milliseconds, stopped);
      } catch (error) { if (!stopped.aborted) throw error; }
    }
    if (listenerError) throw listenerError;
  } finally {
    fatal.abort(); active?.destroy(); active = undefined; destroySockets();
    await new Promise<void>(done => listener.close(() => done()));
  }
}
