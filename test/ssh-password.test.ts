import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { passwordSshConfig, runPasswordSsh } from "../apps/discord/ssh-password.js";

test("explicit pinned IP configuration works without OpenSSH and never silently falls back", async () => {
  const moduleUrl = new URL("../apps/discord/ssh-password.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    const { passwordSshConfig, runPasswordSsh } = await import(${JSON.stringify(moduleUrl)});
    const key = Buffer.from('independently-verified-fixture-key');
    const target = { id:'test', label:'test', kind:'ssh', cwd:'/', host:'127.0.0.1', user:'test', port:2222, password:'fixture-password',
      hostKeySha256:'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/, '') };
    const config = await passwordSshConfig(target, 'direct-pinned');
    assert.equal(config.host, target.host); assert.equal(config.port, 2222); assert.equal(config.username, 'test');
    assert.equal(config.hostVerifier(key), true); assert.equal(config.hostVerifier(Buffer.from('different-key')), false);
    await assert.rejects(passwordSshConfig(target));
    await assert.rejects(runPasswordSsh(target, 'fixture', 1000));
  `;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: { ...environment, PATH: "" }, timeout: 5000, windowsHide: true });
});

test("direct pinned mode rejects aliases, incomplete endpoints and missing verified trust", async () => {
  const target = { id:"test", label:"test", kind:"ssh" as const, cwd:"/", host:"127.0.0.1", user:"test", port:22, password:"fixture-password", hostKeySha256:"SHA256:"+"A".repeat(43) };
  await assert.rejects(passwordSshConfig({ ...target, host:"coordinator-alias" }, "direct-pinned"), /literal IP/);
  await assert.rejects(passwordSshConfig({ ...target, port:undefined }, "direct-pinned"), /explicit user\/port/);
  await assert.rejects(passwordSshConfig({ ...target, hostKeySha256:undefined }, "direct-pinned"), /fingerprint/);
  await assert.rejects(passwordSshConfig({ ...target, hostKeySha256:"unverified" }, "direct-pinned"), /fingerprint/);
});

test("explicit direct pinned real SSH transport verifies host before auth, preserves stdin and exit code", {timeout:15000}, async () => {
  const key=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs1",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}}).privateKey;
  const parsed=utils.parseKey(key); assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const fingerprint="SHA256:"+createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/,"");
  let authenticated=0, passwordAttempts=0;
  const server=new Server({hostKeys:[key]},client=>{
    client.on("error",()=>{});
    client.on("authentication",ctx=>{authenticated++;if(ctx.method==="password")passwordAttempts++;if(ctx.method==="password" && ctx.password==="test-secret")ctx.accept();else ctx.reject();});
    client.on("ready",()=>client.on("session",accept=>{const session=accept();session.on("exec",acceptExec=>{const stream=acceptExec();const chunks:Buffer[]=[];stream.on("data",(b:Buffer)=>chunks.push(b));stream.on("end",()=>{stream.write(Buffer.concat(chunks));stream.stderr.write("test stderr");stream.exit(7);stream.end();});});}));
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  try {
    const port=(server.address() as {port:number}).port;
    const target={id:"test",label:"test",kind:"ssh" as const,cwd:"/tmp",host:"127.0.0.1",user:"test",port,password:"test-secret",hostKeySha256:fingerprint};
    const rejected=await runPasswordSsh({...target,hostKeySha256:"SHA256:"+"A".repeat(43)},"test",1000,undefined,"direct-pinned");
    assert.notEqual(rejected.code,0); assert.equal(authenticated,0);
    const result=await runPasswordSsh(target,"test",1000,"Tiếng Việt\n","direct-pinned");
    assert.equal(passwordAttempts,1);
    assert.equal(result.stdout,"Tiếng Việt\n");assert.equal(result.stderr,"test stderr");assert.equal(result.code,7);assert.equal(result.timedOut,false);
  } finally { await new Promise<void>(done=>server.close(()=>done())); }
});
