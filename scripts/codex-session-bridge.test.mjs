import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { bridgeSocketPath, localEndpoint } from "./codex-local-endpoint.mjs";
const realSetTimeout = setTimeout;
import WebSocket from "ws";
import { createCodexSessionBridge } from "./codex-session-bridge.mjs";

test("Windows pipes require authentication before the bridge binds", async () => {
  await assert.rejects(
    createCodexSessionBridge({
      codexPath: process.execPath,
      endpoint: "npipe://./pipe/codexboard-test",
    }),
    /认证令牌/,
  );
});

test("local bridge accepts the capability and rejects other local clients", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-local-bridge-"));
  const path = bridgeSocketPath(directory);
  const bridge = await createCodexSessionBridge({
    codexPath: process.execPath,
    endpoint: localEndpoint(path),
    token: "local-capability",
  });
  const connect = (token) =>
    new WebSocket("ws://localhost/", {
      createConnection: () => createConnection({ path }),
      headers: { Authorization: `Bearer ${token}` },
    });
  try {
    const rejected = connect("wrong");
    await new Promise((resolve, reject) => {
      rejected.once("open", () => reject(new Error("unauthorized connection accepted")));
      rejected.once("error", (error) => {
        assert.match(error.message, /403/);
        resolve();
      });
    });
    const accepted = connect("local-capability");
    await new Promise((resolve, reject) => {
      accepted.once("open", resolve);
      accepted.once("error", reject);
    });
    await new Promise((resolve) => {
      accepted.once("close", resolve);
      accepted.close();
    });
  } finally {
    await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("honors WebSocket's default port instead of selecting a random port", async () => {
  let bridge;
  try {
    bridge = await createCodexSessionBridge({
      codexPath: process.execPath,
      endpoint: "ws://127.0.0.1:80",
      token: "test-token",
    });
    assert.equal(bridge.endpoint, "ws://127.0.0.1:80");
  } catch (error) {
    if (["EADDRINUSE", "EACCES"].includes(error.code)) {
      assert.equal(error.address, "127.0.0.1");
      assert.equal(error.port, 80);
    } else throw error;
  } finally {
    await bridge?.close();
  }
});

test("persists and releases creators before using Desktop exclusively for turns", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-session-bridge-"));
  const command = join(directory, "fake-codex.cjs");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
let lock, thread;
const loaded = new Set();
const events = ${JSON.stringify(join(directory, "archive-events.log"))};
const record = event => fs.appendFileSync(events, event+'\\n');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if (!('id' in m)) return;
 if(m.method) fs.appendFileSync(${JSON.stringify(join(directory, "helper-methods.log"))},m.method+'\\n');
 if(m.method==='config/read') {
  const reviewer = {'/auto':'auto_review','/ask':'user','/legacy':'guardian_subagent','/invalid':'bad'}[m.params.cwd];
  if(m.params.cwd==='/config-error') return send({id:m.id,error:{code:-32603,message:'config unavailable'}});
  return send({id:m.id,result:{config:{approvals_reviewer:reviewer ?? null}}});
 }
 if(m.method==='account/rateLimits/read') return send({id:m.id,result:{rateLimits:{secondary:{usedPercent:37}}}});
 if(m.method==='thread/list') return send({id:m.id,result:{data:[{id:'11111111-1111-4111-8111-111111111111',name:'old',preview:'opening'}],nextCursor:'next'}});
 if(m.method==='thread/name/set') {
  fs.appendFileSync(${JSON.stringify(join(directory, "session_index.jsonl"))},JSON.stringify({id:m.params.threadId,thread_name:m.params.name})+'\\n');
  return send({id:m.id,result:{}});
 }
 if(m.method==='initialize') return send({id:m.id,result:{codexHome:${JSON.stringify(directory)}}});
 if(m.method==='thread/start'||m.method==='thread/resume') {
  const id=m.params.threadId || m.params.cwd; thread=id;
  if(id==='desktop-thread') return send({id:m.id,error:{code:-32600,message:'thread desktop-thread already has an active writer'}});
  lock=${JSON.stringify(directory)}+'/'+id+'.lock';
  try { fs.writeFileSync(lock,'locked',{flag:'wx'}); } catch { return send({id:m.id,error:{code:-32603,message:'thread locked'}}); }
  if(id==='slow-thread') return send({method:'test/startReceived'});
  return send({id:m.id,result:{thread:{id},cwd:m.params.cwd}});
 }
 if(m.method==='thread/read') {
  const id=m.params.threadId;
  if(id==='historical-thread'||id==='serial-thread') {
   loaded.add(id);
   lock=${JSON.stringify(directory)}+'/'+id+'.lock';
   try { fs.writeFileSync(lock,'read',{flag:'wx'}); } catch { return send({id:m.id,error:{code:-32603,message:'thread locked'}}); }
   record('read:'+id);
   return send({id:m.id,result:{thread:{id,path:${JSON.stringify(join(directory, "sessions"))}+'/'+id+'.jsonl'}}});
  }
  if(id==='archived-thread') {
   record('read:'+id);
   return send({id:m.id,result:{thread:{id,path:${JSON.stringify(join(directory, "archived_sessions", "archived-thread.jsonl"))}}}});
  }
  return send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+id}});
 }
 if(m.method==='thread/archive') {
  const id=m.params.threadId;
  record('archive:'+id);
  if(!loaded.has(id)) return send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+id}});
  return send({id:m.id,result:{}});
 }
 if(m.method==='thread/section/move') fs.writeFileSync(lock+'.saved','saved');
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn-1'}}});
  return send({id:77,method:'item/commandExecution/requestApproval',params:{threadId:thread}});
 }
 if(!m.method && m.id===77) return send({method:'item/completed',params:{threadId:thread,item:{type:'agentMessage',text:m.result.decision}}});
 send({id:m.id,result:{}});
});
const finish=()=>setTimeout(()=>{if(lock && fs.existsSync(lock)) fs.unlinkSync(lock);process.exit(0);},50);
process.on('SIGTERM',finish);
process.stdin.on('end',finish);
`,
    { mode: 0o700 },
  );
  const desktopRequests = [];
  let desktopStopped = false;
  let desktopConnections = 0;
  const bridge = await createCodexSessionBridge({
    codexPath: process.execPath,
    spawnProcess: (executable, args, options) => spawn(executable, [command, ...args], options),
    endpoint: "ws://127.0.0.1:0",
    token: "test-token",
    desktopSessionConnector: async ({ threadId, onMessage }) => {
      desktopConnections += 1;
      assert.equal(existsSync(join(directory, threadId + ".lock")), false);
      let liveRevision = 0;
      const liveTimer =
        threadId === "live-remote"
          ? realSetTimeout(() => {
              liveRevision = 1;
            }, 30)
          : null;
      return {
        request: async (method, params) => {
          desktopRequests.push({ method, params });
          if (
            threadId === "live-remote" &&
            ["taskboard/remote/steer", "taskboard/remote/queue"].includes(method)
          ) {
            if (liveRevision !== 1) throw new Error("当前回合已变化，请刷新后操作");
            return { revision: liveRevision };
          }
          if (method === "taskboard/remote/read" && threadId === "owner-active")
            return {
              id: threadId,
              cwd: "/project",
              turnHistory: {
                kind: "canonical",
                history: {
                  entitiesByKey: {
                    live: {
                      turnId: "turn-live",
                      status: "inProgress",
                      params: {
                        clientUserMessageId: "job-live",
                        input: [{ type: "text", text: "continue" }],
                      },
                      items: [],
                    },
                  },
                },
              },
            };
          if (method === "taskboard/remote/read" && threadId === "owner-unreachable")
            throw new Error("owner unavailable");
          if (method === "taskboard/remote/read" && threadId === "live-remote")
            return { id: threadId, revision: liveRevision };
          if (method === "taskboard/remote/read" && threadId === "review-thread")
            return {
              id: threadId,
              cwd: directory,
              turns: [
                {
                  diff: "diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new\n",
                },
              ],
            };
          if (method === "taskboard/remote/read")
            return threadId === "image-thread"
              ? {
                  id: threadId,
                  turns: [
                    {
                      items: [
                        { id: "image", type: "imageView", path: join(directory, "image.png") },
                      ],
                    },
                  ],
                }
              : { id: threadId };
          if (method === "thread/resume") return { thread: { id: threadId }, cwd: "/recent" };
          if (method === "turn/start" && threadId !== "desktop-thread") {
            onMessage({
              id: 77,
              method: "item/commandExecution/requestApproval",
              params: { threadId },
            });
          }
          return { turn: { id: "desktop-turn" } };
        },
        write: async (m) =>
          onMessage({
            method: "item/completed",
            params: { threadId, item: { type: "agentMessage", text: m.result.decision } },
          }),
        stop: async () => {
          if (liveTimer) clearTimeout(liveTimer);
          desktopStopped = true;
        },
      };
    },
  });
  const socket = new WebSocket(bridge.endpoint, {
    headers: { authorization: "Bearer test-token" },
  });
  let slowStarted;
  const slowReady = new Promise((resolve) => {
    slowStarted = resolve;
  });
  const approvals = [];
  const replies = [];
  const pending = new Map();
  let nextId = 1;
  socket.on("message", (data) => {
    const m = JSON.parse(String(data));
    if (m.method === "test/startReceived") slowStarted();
    if (m.method === "item/commandExecution/requestApproval") approvals.push(m);
    if (m.method === "item/completed") replies.push(m);
    const waiter = pending.get(m.id);
    if (waiter) {
      pending.delete(m.id);
      if (m.error) waiter.reject(new Error(m.error.message));
      else waiter.resolve(m.result);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: "Bearer test-token", origin: "https://untrusted.example" },
    ]) {
      const status = await new Promise((resolve, reject) => {
        const unauthorized = new WebSocket(bridge.endpoint, { headers });
        unauthorized.once("unexpected-response", (_request, response) => {
          response.resume();
          unauthorized.terminate();
          resolve(response.statusCode);
        });
        unauthorized.once("open", () => {
          unauthorized.terminate();
          reject(new Error("unauthorized connection accepted"));
        });
        unauthorized.on("error", () => {});
      });
      assert.equal(status, 403);
    }
    await request("initialize", { clientInfo: { name: "test", version: "1" } });
    assert.deepEqual(await request("account/rateLimits/read"), {
      rateLimits: { secondary: { usedPercent: 37 } },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    const videoBytes = 13 * 1024 * 1024;
    const uploadedVideo = await request("taskboard/remote/upload", {
      ownerKey: "a".repeat(64),
      id: "33333333-3333-4333-8333-333333333333",
      name: "ScreenRecording.MOV",
      mimeType: "video/quicktime",
      base64: Buffer.alloc(videoBytes, 7).toString("base64"),
    });
    assert.equal(
      uploadedVideo.size,
      videoBytes,
      "recordings must cross the former 16 MiB WebSocket frame limit",
    );

    mkdirSync(join(directory, "sessions"));
    const originThread = "11111111-1111-4111-8111-111111111111";
    writeFileSync(
      join(directory, "sessions", "origin.jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: originThread,
          started_at_ms: 100000,
          completed_at_ms: 100500,
          item: {
            type: "CommandExecution",
            command: ["git", "branch", "feature/origin"],
            cwd: "/repo",
            exit_code: 0,
          },
        },
      }) + "\n",
    );
    const origins = await request("taskboard/gitOrigins", {
      mainPath: "/repo",
      resources: [
        {
          key: "branch",
          kind: "branch",
          branch: "feature/origin",
          path: null,
          createdAt: new Date(100000).toISOString(),
        },
      ],
    });
    assert.equal(origins.branch.threadId, originThread);

    const methodsBeforeRename = readFileSync(join(directory, "helper-methods.log"), "utf8");
    const connectionsBeforeRename = desktopConnections;
    await request("taskboard/remote/rename", { threadId: originThread, name: "新标题" });
    assert.equal(desktopConnections, connectionsBeforeRename, "rename must not load Desktop");
    assert.equal(
      readFileSync(join(directory, "helper-methods.log"), "utf8").slice(methodsBeforeRename.length),
      "thread/name/set\n",
      "rename must only write metadata, without initializing helpers or loading/resuming a thread",
    );
    assert.equal(
      (await request("taskboard/remote/read", { threadId: originThread })).title,
      "新标题",
    );

    const desktop = await request("thread/resume", { threadId: "desktop-thread", cwd: "/recent" });
    assert.equal(desktop.thread.id, "desktop-thread");
    const connectionsBeforeRemote = desktopConnections;
    assert.deepEqual(await request("taskboard/remote/read", { threadId: "desktop-thread" }), {
      id: "desktop-thread",
    });
    assert.equal(
      (await request("turn/start", { threadId: "desktop-thread" })).turn.id,
      "desktop-turn",
    );
    assert.equal(
      desktopConnections,
      connectionsBeforeRemote + 1,
      "remote read must not release the task executor's follower",
    );
    const helperBeforeOutcome = readFileSync(join(directory, "helper-methods.log"), "utf8");
    const executionRequests = desktopRequests.filter((r) =>
      ["turn/start", "thread/resume", "turn/interrupt"].includes(r.method),
    ).length;
    const ownerHistory = await request("thread/read", {
      threadId: "owner-active",
      includeTurns: true,
    });
    assert.equal(ownerHistory.thread.turns[0].status, "inProgress");
    assert.equal(ownerHistory.thread.turns[0].items[0].clientId, "job-live");
    assert.equal(
      desktopRequests.filter((r) =>
        ["turn/start", "thread/resume", "turn/interrupt"].includes(r.method),
      ).length,
      executionRequests,
    );
    await assert.rejects(
      request("thread/read", { threadId: "owner-unreachable", includeTurns: true }),
      /Codex 会话连接失败/,
    );
    assert.equal(
      readFileSync(join(directory, "helper-methods.log"), "utf8"),
      helperBeforeOutcome,
      "outcome reads must not fall back to persisted App Server history",
    );
    const beforeLive = desktopConnections;
    assert.equal((await request("taskboard/remote/read", { threadId: "live-remote" })).revision, 0);
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    assert.equal((await request("taskboard/remote/read", { threadId: "live-remote" })).revision, 1);
    assert.equal(
      desktopConnections,
      beforeLive + 1,
      "polling must retain the read-only follower to receive later patches",
    );
    for (const method of ["taskboard/remote/steer", "taskboard/remote/queue"]) {
      assert.equal(
        (await request(method, { threadId: "live-remote", turnId: "current" })).revision,
        1,
      );
    }
    assert.equal(
      desktopConnections,
      beforeLive + 1,
      "guidance must use the same hydrated follower as the displayed conversation",
    );
    writeFileSync(
      join(directory, "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const helperMethodsBeforeImage = readFileSync(join(directory, "helper-methods.log"), "utf8");
    const image = await request("taskboard/remote/image", {
      threadId: "image-thread",
      itemId: "image",
      imageIndex: 0,
    });
    assert.equal(image.mimeType, "image/png");
    assert.equal(
      readFileSync(join(directory, "helper-methods.log"), "utf8"),
      helperMethodsBeforeImage,
      "image reads must only follow Desktop and must not resume an App Server thread",
    );
    const review = await request("taskboard/remote/review", {
      threadId: "review-thread",
      scope: "turn",
    });
    assert.equal(review.changedCount, 1);
    assert.equal(review.files[0].path, "test.txt");
    const reviewedFile = await request("taskboard/remote/review", {
      threadId: "review-thread",
      scope: "turn",
      path: "test.txt",
    });
    assert.match(reviewedFile.patch, /\+new/);
    assert.equal(
      readFileSync(join(directory, "helper-methods.log"), "utf8"),
      helperMethodsBeforeImage,
      "review must only follow Desktop and must not initialize or resume a helper thread",
    );
    // The same existing Desktop thread may still have reviewer=user saved.
    // Each task turn must use the current project config, without relaxing its sandbox.
    for (const [cwd, reviewer] of [
      ["/auto", "auto_review"],
      ["/ask", "user"],
      ["/legacy", "auto_review"],
      ["/unset", undefined],
    ]) {
      await request("turn/start", { threadId: "desktop-thread", cwd, input: [] });
      const sent = desktopRequests.at(-1);
      assert.equal(sent.method, "turn/start");
      assert.equal(sent.params.approvalsReviewer, reviewer);
      for (const key of ["approvalPolicy", "sandbox", "sandboxPolicy"])
        assert.equal(Object.hasOwn(sent.params, key), false);
    }
    for (const cwd of ["/invalid", "/config-error"]) {
      const before = desktopRequests.length;
      await assert.rejects(request("turn/start", { threadId: "desktop-thread", cwd, input: [] }));
      assert.equal(desktopRequests.length, before, "configuration errors must not dispatch a turn");
    }
    await request("thread/unsubscribe", { threadId: "desktop-thread" });
    assert.equal(desktopStopped, true);
    await request("thread/start", { cwd: "thread-a" });
    await request("thread/start", { cwd: "thread-b" });
    assert.equal(existsSync(join(directory, "thread-a.lock")), false);
    assert.equal(existsSync(join(directory, "thread-a.lock.saved")), true);
    await Promise.all([
      request("turn/start", { threadId: "thread-a" }),
      request("turn/start", { threadId: "thread-b" }),
    ]);
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error("approval timeout"));
      }, 2000);
      const timer = setInterval(() => {
        if (approvals.length === 2) {
          clearInterval(timer);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
    assert.notEqual(approvals[0].id, approvals[1].id);
    for (const approval of approvals)
      socket.send(
        JSON.stringify({ id: approval.id, result: { decision: approval.params.threadId } }),
      );
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error("reply timeout"));
      }, 2000);
      const timer = setInterval(() => {
        if (replies.length === 2) {
          clearInterval(timer);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
    for (const reply of replies) assert.equal(reply.params.item.text, reply.params.threadId);
    await request("thread/unsubscribe", { threadId: "thread-a" });
    assert.equal(existsSync(join(directory, "thread-a.lock")), false);
    assert.equal(existsSync(join(directory, "thread-b.lock")), false);
    const resumed = await request("thread/resume", { threadId: "thread-a", cwd: "thread-a" });
    assert.equal(resumed.thread.id, "thread-a");
    await request("thread/unsubscribe", { threadId: "thread-a" });
    const releasing = request("thread/unsubscribe", { threadId: "thread-b" });
    const immediatelyResumed = request("thread/resume", { threadId: "thread-b", cwd: "thread-b" });
    const [, resumeResult] = await Promise.all([releasing, immediatelyResumed]);
    assert.equal(resumeResult.thread.id, "thread-b");
    await request("thread/unsubscribe", { threadId: "thread-b" });
    assert.deepEqual(await request("thread/archive", { threadId: "historical-thread" }), {});
    assert.equal(
      readFileSync(join(directory, "archive-events.log"), "utf8"),
      "read:historical-thread\narchive:historical-thread\n",
    );
    const serialArchive = request("thread/archive", { threadId: "serial-thread" });
    const serialResume = request("thread/resume", {
      threadId: "serial-thread",
      cwd: "serial-thread",
    });
    const [serialArchiveResult, serialResumeResult] = await Promise.all([
      serialArchive,
      serialResume,
    ]);
    assert.deepEqual(serialArchiveResult, {});
    assert.equal(serialResumeResult.thread.id, "serial-thread");
    await request("thread/unsubscribe", { threadId: "serial-thread" });
    assert.deepEqual(await request("thread/archive", { threadId: "archived-thread" }), {});
    assert.equal(
      readFileSync(join(directory, "archive-events.log"), "utf8"),
      "read:historical-thread\narchive:historical-thread\nread:serial-thread\narchive:serial-thread\nread:archived-thread\n",
    );
    await assert.rejects(
      request("thread/archive", { threadId: "unknown-thread" }),
      /no rollout found for thread id unknown-thread/,
    );
    const titleThread = "11111111-1111-4111-8111-111111111111";
    await request("taskboard/remote/rename", {
      threadId: titleThread,
      name: "Latest Desktop title",
    });
    const titleList = await request("thread/list", {});
    assert.equal(titleList.data[0].name, "Latest Desktop title");
    assert.equal(titleList.data[0].preview, "opening");
    assert.equal(titleList.nextCursor, "next");
    await request("thread/name/set", { threadId: "thread-a", name: "named" });
    await assert.rejects(request("turn/steer", { threadId: "thread-a" }));
    await assert.rejects(request("thread/start", { cwd: "ephemeral", ephemeral: true }));
    const helperMethods = readFileSync(join(directory, "helper-methods.log"), "utf8").split("\n");
    assert.equal(helperMethods.includes("thread/resume"), false);
    assert.equal(
      helperMethods.some((method) => method.startsWith("turn/")),
      false,
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timedOut = request("thread/start", { cwd: "slow-thread" }).then(
      () => false,
      () => true,
    );
    await slowReady;
    t.mock.timers.tick(20_001);
    assert.equal(
      await Promise.race([
        timedOut,
        new Promise((resolve) => realSetTimeout(() => resolve(false), 500)),
      ]),
      true,
    );
    assert.equal(existsSync(join(directory, "slow-thread.lock")), false);
    t.mock.timers.reset();
  } finally {
    t.mock.timers.reset();
    socket.close();
    await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
