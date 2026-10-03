import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { Server, Socket } from "node:net";
import ssh2 from "ssh2";
import { runReconnectingTunnel } from "../apps/discord/agent-tunnel-runtime.js";

const tick = () => new Promise<void>(done => setImmediate(done));
class Endpoint extends Duplex {
  remotePort = 34567;
  written: string[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) { this.written.push(chunk.toString()); done(); }
}
class FakeClient extends EventEmitter {
  config?: ssh2.ConnectConfig;
  destroyed = false;
  forwards: { addresses: unknown[]; stream: Endpoint }[] = [];
  connect(config: ssh2.ConnectConfig) { this.config = config; return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
  forwardOut(source: string, sourcePort: number, target: string, targetPort: number, callback: (error: Error | undefined, channel: Endpoint) => void) {
    const stream = new Endpoint(); this.forwards.push({ addresses: [source, sourcePort, target, targetPort], stream });
    callback(undefined, stream); return this;
  }
}
class FakeListener extends EventEmitter {
  binds: unknown[][] = [];
  closed = 0;
  occupied = false;
  accept!: (socket: Socket) => void;
  listen(port: number, host: string) {
    this.binds.push([port, host]);
    queueMicrotask(() => this.emit(this.occupied ? "error" : "listening", ...(this.occupied ? [new Error("EADDRINUSE")] : [])));
    return this;
  }
  close(done: () => void) { this.closed++; queueMicrotask(done); return this; }
  open(socket: Endpoint) { this.accept(socket as unknown as Socket); }
}
function fixture() {
  const abort = new AbortController(), listener = new FakeListener(), clients: FakeClient[] = [];
  const waits: { milliseconds: number; next: () => void }[] = [];
  const trust = () => true;
  const config: ssh2.ConnectConfig = { host: "private-coordinator", username: "test-user", hostVerifier: trust };
  const running = runReconnectingTunnel({ localPort: 8788, config,
    createListener: accept => { listener.accept = accept; return listener as unknown as Server; },
    createClient: () => { const client = new FakeClient(); clients.push(client); return client as unknown as ssh2.Client; },
    wait: (milliseconds, signal) => new Promise<void>((done, reject) => {
      const failed = () => reject(new Error("aborted"));
      const next = () => { signal.removeEventListener("abort", failed); done(); };
      signal.addEventListener("abort", failed, { once: true }); waits.push({ milliseconds, next });
    }),
  }, abort.signal);
  return { abort, listener, clients, waits, config, running, async stop() { abort.abort(); await running; } };
}

test("SSH tunnel retries with backoff, keeps one loopback bind and preserves host trust", async () => {
  const f = fixture();
  try {
    await tick(); assert.equal(f.clients.length, 1);
    const offline = new Endpoint(); f.listener.open(offline); assert.equal(offline.destroyed, true);
    f.clients[0].emit("error", new Error("offline")); await tick();
    assert.equal(f.waits[0].milliseconds, 1000); f.waits[0].next(); await tick();
    f.clients[1].emit("error", new Error("offline")); await tick();
    assert.equal(f.waits[1].milliseconds, 2000); f.waits[1].next(); await tick();
    f.clients[2].emit("ready");
    const live = new Endpoint(); f.listener.open(live);
    assert.deepEqual(f.clients[2].forwards[0].addresses, ["127.0.0.1", 34567, "127.0.0.1", 8787]);
    f.clients[2].destroy(); await tick(); assert.equal(live.destroyed, true);
    assert.equal(f.waits[2].milliseconds, 1000);
    assert.deepEqual(f.listener.binds, [[8788, "127.0.0.1"]]);
    for (const client of f.clients) assert.equal(client.config?.hostVerifier, f.config.hostVerifier);
  } finally { await f.stop(); }
  assert.equal(f.listener.closed, 1);
});

test("transport loss destroys requests instead of replaying bytes on the new SSH connection", async () => {
  const f = fixture();
  try {
    await tick(); f.clients[0].emit("ready");
    const original = new Endpoint(); f.listener.open(original);
    original.push(Buffer.from("input-once")); await tick();
    assert.deepEqual(f.clients[0].forwards[0].stream.written, ["input-once"]);
    f.clients[0].destroy(); await tick();
    assert.equal(original.destroyed, true); assert.equal(f.clients[0].forwards[0].stream.destroyed, true);
    f.waits[0].next(); await tick(); f.clients[1].emit("ready");
    assert.equal(f.clients[1].forwards.length, 0);
    const fresh = new Endpoint(); f.listener.open(fresh); fresh.push(Buffer.from("new-request")); await tick();
    assert.deepEqual(f.clients[1].forwards[0].stream.written, ["new-request"]);
    // A late event from the retired transport must not affect the current one.
    f.clients[0].emit("error", new Error("late close")); assert.equal(fresh.destroyed, false);
  } finally { await f.stop(); }
  assert.ok(f.clients.every(client => client.destroyed));
});

test("shutdown cancels a connecting SSH client and never starts a replacement", async () => {
  const f = fixture(); await tick(); await f.stop(); await tick();
  assert.equal(f.clients.length, 1); assert.equal(f.clients[0].destroyed, true);
  assert.equal(f.waits.length, 0); assert.equal(f.listener.closed, 1);
});

test("occupied loopback port fails without creating SSH clients", async () => {
  const listener = new FakeListener(); listener.occupied = true; let clients = 0;
  await assert.rejects(runReconnectingTunnel({ localPort: 8788, config: {},
    createListener: () => listener as unknown as Server,
    createClient: () => { clients++; return new FakeClient() as unknown as ssh2.Client; },
  }, new AbortController().signal), /EADDRINUSE/);
  assert.equal(clients, 0); assert.equal(listener.closed, 1);
});
