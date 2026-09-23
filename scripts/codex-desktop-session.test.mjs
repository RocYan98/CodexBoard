import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { storeRemoteUpload } from "./codex-remote-upload.mjs";
import { connectDesktopSession } from "./codex-desktop-session.mjs";
import { bridgeSocketPath } from "./codex-local-endpoint.mjs";

test("remote send applies explicit approval presets only through the existing owner", async (t) => {
  const f = await fixture(t);
  await f.session.request("taskboard/remote/send", {
    threadId: "thread-a",
    text: "hello",
    clientUserMessageId: "preset-send",
    approvalMode: "auto",
  });
  const sent = f.requests.find((r) => r.method === "thread-follower-start-turn");
  assert.equal(sent.targetClientId, "owner");
  assert.equal(sent.params.turnStart.request.approvalsReviewer, "auto_review");
  assert.equal(sent.params.turnStart.request.approvalPolicy, "on-request");
  assert.equal(sent.params.turnStart.request.sandboxPolicy.type, "workspaceWrite");
  assert.equal(
    f.requests.some((r) => /resume|interrupt|update-thread-settings/.test(r.method)),
    false,
  );
});

for (const [approvalMode, policy, reviewer, sandbox] of [
  ["ask", "on-request", "user", "workspaceWrite"],
  ["full", "never", "user", "dangerFullAccess"],
]) {
  test(`remote ${approvalMode} preset stays on the owner`, async (t) => {
    const f = await fixture(t);
    await f.session.request("taskboard/remote/send", {
      threadId: "thread-a",
      text: "hello",
      clientUserMessageId: "preset",
      approvalMode,
    });
    const sent = f.requests.find((r) => r.method === "thread-follower-start-turn");
    assert.equal(sent.targetClientId, "owner");
    assert.equal(sent.params.turnStart.request.approvalPolicy, policy);
    assert.equal(sent.params.turnStart.request.approvalsReviewer, reviewer);
    assert.equal(sent.params.turnStart.request.sandboxPolicy.type, sandbox);
    assert.equal(
      f.requests.some((r) => /resume|interrupt|update-thread-settings/.test(r.method)),
      false,
    );
  });
}

test("remote attachments resolve actor-bound files before forwarding to the owner", async (t) => {
  const f = await fixture(t);
  const ownerKey = "a".repeat(64);
  const id = "11111111-1111-4111-8111-111111111111";
  await storeRemoteUpload(f.directory, {
    ownerKey,
    id,
    name: "笔记.txt",
    mimeType: "text/plain",
    base64: Buffer.from("hello").toString("base64"),
  });
  const imageId = "33333333-3333-4333-8333-333333333333";
  await storeRemoteUpload(f.directory, {
    ownerKey,
    id: imageId,
    name: "photo.png",
    mimeType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
  });
  await assert.rejects(
    f.session.request("taskboard/remote/send", {
      threadId: "thread-a",
      text: "",
      clientUserMessageId: "invalid",
      ownerKey: "b".repeat(64),
      attachments: [id],
    }),
  );
  assert.equal(
    f.requests.some((r) => r.method === "thread-follower-start-turn"),
    false,
  );
  await f.session.request("taskboard/remote/send", {
    threadId: "thread-a",
    text: "",
    clientUserMessageId: "file-send",
    ownerKey,
    attachments: [id, imageId],
  });
  const sent = f.requests.find((r) => r.method === "thread-follower-start-turn");
  assert.equal(sent.targetClientId, "owner");
  assert.match(sent.params.turnStart.request.input[0].text, /笔记.txt/);
  assert.equal(sent.params.turnStart.request.input[1].type, "localImage");
  assert.ok(sent.params.turnStart.request.input[1].path.includes(imageId));
  assert.equal(
    f.requests.some((r) => /resume|interrupt/.test(r.method)),
    false,
  );
});

test("remote first read waits for the owner's confirmed history revision", async (t) => {
  const f = await fixture(t, {
    initialState: { turns: [{ turnId: "old", status: "completed", items: [] }] },
    hydratedState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
    historyDelayMs: 30,
  });
  const state = await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.equal(state.turns.at(-1).turnId, "running");
  await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.equal(
    f.requests.filter((r) => r.method === "thread-follower-load-complete-history").length,
    1,
  );
});

test("remote first read never exposes an old snapshot when synchronization fails", async (t) => {
  const f = await fixture(t, { rejectMethod: "thread-follower-load-complete-history" });
  await assert.rejects(
    f.session.request("taskboard/remote/read", { threadId: "thread-a" }),
    /桌面/,
  );
});

test("remote steering stays on the running owner and does not start, interrupt or resume", async (t) => {
  const f = await fixture(t, {
    initialState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
  });
  const action = {
    threadId: "thread-a",
    turnId: "running",
    text: "先处理权限审批",
    clientUserMessageId: "steer-1",
  };
  await assert.rejects(
    f.session.request("taskboard/remote/steer", { ...action, turnId: "stale" }),
    /回合/,
  );
  const response = await f.session.request("taskboard/remote/steer", action);
  assert.equal(response.turnId, "running");
  const sent = f.requests.find((r) => r.method === "thread-follower-steer-turn");
  assert.equal(sent.targetClientId, "owner");
  assert.equal(sent.params.clientUserMessageId, "steer-1");
  await f.session.request("taskboard/remote/steer", {
    ...action,
    clientUserMessageId: "steer-followup",
    text: "继续补充",
  });
  assert.equal(f.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 2);

  assert.deepEqual(sent.params.input, [{ type: "text", text: action.text, text_elements: [] }]);
  assert.equal(sent.params.toolOutput, undefined);
  assert.equal(sent.params.restoreMessage.cwd, "/recent");
  assert.equal(
    f.requests.some((r) => /start-turn|resume|interrupt|update-thread-settings/.test(r.method)),
    false,
  );
});

test("remote steering rejects pending approvals and does not retry a rejected owner", async (t) => {
  const blocked = await fixture(t, {
    initialState: {
      turns: [{ turnId: "running", status: "inProgress", items: [] }],
      requests: [{ id: "approval" }],
    },
  });
  const action = {
    threadId: "thread-a",
    turnId: "running",
    text: "hello",
    clientUserMessageId: "steer-2",
  };
  await assert.rejects(blocked.session.request("taskboard/remote/steer", action), /请求/);
  assert.equal(
    blocked.requests.some((r) => r.method === "thread-follower-steer-turn"),
    false,
  );
  const f = await fixture(t, {
    rejectMethod: "thread-follower-steer-turn",
    initialState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
  });
  await assert.rejects(f.session.request("taskboard/remote/steer", action));
  assert.equal(f.requests.filter((r) => r.method === "thread-follower-steer-turn").length, 1);
  assert.equal(
    f.requests.some((r) => /start-turn|resume|interrupt/.test(r.method)),
    false,
  );
});

test("remote permission approval grants only the reviewed request for this turn", async (t) => {
  const params = {
    reason: "verify",
    permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/tmp/output"] } },
  };
  const permissionToken = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  const f = await fixture(t, {
    initialState: {
      requests: [{ id: "permission", method: "item/permissions/requestApproval", params }],
    },
  });
  const action = {
    threadId: "thread-a",
    requestId: "permission",
    decision: "accept",
    permissionToken,
  };
  await assert.rejects(
    f.session.request("taskboard/remote/respond", { ...action, permissionToken: "stale" }),
    /变化/,
  );
  await assert.rejects(
    f.session.request("taskboard/remote/respond", { ...action, decision: "cancel" }),
    /无效/,
  );
  await f.session.request("taskboard/remote/respond", action);
  const sent = f.requests.filter(
    (r) => r.method === "thread-follower-permissions-request-approval-response",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetClientId, "owner");
  assert.deepEqual(sent[0].params, {
    conversationId: "thread-a",
    requestId: "permission",
    response: { permissions: params.permissions, scope: "turn" },
  });
  assert.equal(
    f.requests.some((r) => /start-turn|resume|update-thread-settings|interrupt/.test(r.method)),
    false,
  );
});

test("remote queue appends, edits and cancels through the existing owner with stale protection", async (t) => {
  const f = await fixture(t, {
    initialState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
  });
  let read = await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.equal(read.remoteQueue.available, true);
  const append = {
    threadId: "thread-a",
    operation: "append",
    text: "queued text",
    turnId: "running",
    queueToken: read.remoteQueue.token,
    clientUserMessageId: "queue-1",
  };
  await f.session.request("taskboard/remote/queue", append);
  read = await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.equal(read.remoteQueue.messages[0].text, "queued text");
  await assert.rejects(
    f.session.request("taskboard/remote/queue", {
      ...append,
      operation: "cancel",
      messageId: "queue-1",
    }),
    /已变化/,
  );
  await f.session.request("taskboard/remote/queue", {
    ...append,
    operation: "edit",
    messageId: "queue-1",
    text: "edited text",
    queueToken: read.remoteQueue.token,
  });
  read = await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.equal(read.remoteQueue.messages[0].text, "edited text");
  await f.session.request("taskboard/remote/queue", {
    ...append,
    operation: "cancel",
    messageId: "queue-1",
    queueToken: read.remoteQueue.token,
  });
  read = await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.deepEqual(read.remoteQueue.messages, []);
  const writes = f.requests.filter(
    (r) => r.method === "thread-follower-set-queued-follow-ups-state",
  );
  assert.equal(writes.length, 3);
  assert.equal(
    writes.every((r) => r.targetClientId === "owner" && r.version === 1),
    true,
  );
  assert.equal(
    f.requests.some((r) => /start-turn|steer-turn|resume|interrupt/.test(r.method)),
    false,
  );
});

for (const reject of [false, true]) {
  test(`queue steering removes from owner queue before submitting, reject=${reject}`, async (t) => {
    const f = await fixture(t, {
      initialState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
      ...(reject ? { rejectMethod: "thread-follower-steer-turn" } : {}),
    });
    const read = () => f.session.request("taskboard/remote/read", { threadId: "thread-a" });
    await f.session.request("taskboard/remote/queue", {
      threadId: "thread-a",
      operation: "append",
      text: "follow up",
      turnId: "running",
      queueToken: (await read()).remoteQueue.token,
      clientUserMessageId: "queued-steer",
    });
    const action = {
      threadId: "thread-a",
      operation: "steer",
      messageId: "queued-steer",
      turnId: "running",
      queueToken: (await read()).remoteQueue.token,
    };
    await assert.rejects(
      f.session.request("taskboard/remote/queue", { ...action, turnId: "stale" }),
    );
    assert.equal((await read()).remoteQueue.messages.length, 1);
    if (reject) await assert.rejects(f.session.request("taskboard/remote/queue", action));
    else await f.session.request("taskboard/remote/queue", action);
    assert.deepEqual((await read()).remoteQueue.messages, []);
    const writes = f.requests.filter((r) =>
      /set-queued-follow-ups-state|steer-turn/.test(r.method),
    );
    assert.deepEqual(
      writes.map((r) => r.method),
      [
        "thread-follower-set-queued-follow-ups-state",
        "thread-follower-set-queued-follow-ups-state",
        "thread-follower-steer-turn",
      ],
    );
    assert.ok(writes.every((r) => r.targetClientId === "owner"));
    assert.equal(writes[2].params.clientUserMessageId, "queued-steer");
    assert.equal(
      f.requests.some((r) => /start-turn|resume|interrupt/.test(r.method)),
      false,
    );
  });
}

test("remote permissions support session scope without broadening the requested profile", async (t) => {
  const params = {
    permissions: { network: { enabled: true }, fileSystem: { write: ["/tmp/output"] } },
  };
  const permissionToken = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  const f = await fixture(t, {
    initialState: {
      requests: [{ id: "permission", method: "item/permissions/requestApproval", params }],
    },
  });
  await f.session.request("taskboard/remote/respond", {
    threadId: "thread-a",
    requestId: "permission",
    decision: "acceptForSession",
    permissionToken,
  });
  assert.deepEqual(f.requests.at(-1).params.response, {
    permissions: params.permissions,
    scope: "session",
  });
  assert.equal(f.requests.at(-1).targetClientId, "owner");
  assert.equal(
    f.requests.some((r) => /start-turn|resume|update-thread-settings|interrupt/.test(r.method)),
    false,
  );
});

test("remote session command approval respects the current supported choices", async (t) => {
  const f = await fixture(t, {
    initialState: {
      requests: [
        {
          id: "session",
          method: "item/commandExecution/requestApproval",
          params: { availableDecisions: ["accept", "acceptForSession", "decline"] },
        },
        {
          id: "restricted",
          method: "item/commandExecution/requestApproval",
          params: { availableDecisions: ["accept", "decline"] },
        },
      ],
    },
  });
  await assert.rejects(
    f.session.request("taskboard/remote/respond", {
      threadId: "thread-a",
      requestId: "restricted",
      decision: "acceptForSession",
    }),
    /不支持此决定/,
  );
  await f.session.request("taskboard/remote/respond", {
    threadId: "thread-a",
    requestId: "session",
    decision: "acceptForSession",
  });
  assert.equal(f.requests.at(-1).params.decision, "acceptForSession");
  assert.equal(f.requests.at(-1).targetClientId, "owner");
});

test("remote permission denial grants nothing and unknown permission types cannot be approved", async (t) => {
  const params = { permissions: { futurePermission: true } };
  const permissionToken = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  const f = await fixture(t, {
    initialState: {
      requests: [{ id: "permission", method: "item/permissions/requestApproval", params }],
    },
  });
  await assert.rejects(
    f.session.request("taskboard/remote/respond", {
      threadId: "thread-a",
      requestId: "permission",
      decision: "accept",
      permissionToken,
    }),
    /桌面/,
  );
  await f.session.request("taskboard/remote/respond", {
    threadId: "thread-a",
    requestId: "permission",
    decision: "decline",
    permissionToken,
  });
  assert.deepEqual(f.requests.at(-1).params.response, { permissions: {}, scope: "turn" });
});

test("remote reads and submits through the owner without claiming or changing its settings", async (t) => {
  const f = await fixture(t);
  const state = await f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  assert.equal(state.id, "thread-a");
  await f.session.request("taskboard/remote/send", {
    threadId: "thread-a",
    text: "continue remotely",
    clientUserMessageId: "remote-1",
  });
  const sent = f.requests.find((r) => r.method === "thread-follower-start-turn");
  assert.equal(sent.params.turnStart.context.inheritThreadSettings, true);
  assert.equal(sent.params.turnStart.request.cwd, "/recent");
  assert.equal(sent.params.turnStart.request.sandboxPolicy, undefined);
  assert.equal(sent.params.turnStart.request.input[0].text, "continue remotely");
  assert.deepEqual(sent.params.turnStart.request.input[0].text_elements, []);
  assert.equal(
    f.requests.some((r) => r.method === "thread/resume"),
    false,
  );
});

test("remote refusal never falls back, retries or accepts arbitrary operations", async (t) => {
  const f = await fixture(t, { rejectMethod: "thread-follower-start-turn" });
  await assert.rejects(
    f.session.request("taskboard/remote/send", {
      threadId: "thread-a",
      text: "hello",
      clientUserMessageId: "remote-2",
    }),
  );
  await assert.rejects(f.session.request("taskboard/remote/archive", { threadId: "thread-a" }));
  assert.equal(f.requests.filter((r) => r.method === "thread-follower-start-turn").length, 1);
});

test("remote model selection also updates the inherited collaboration preset", async (t) => {
  const f = await fixture(t, {
    initialState: {
      latestCollaborationMode: {
        mode: "plan",
        settings: { model: "old", reasoning_effort: "low", developer_instructions: "retain" },
      },
    },
  });
  await f.session.request("taskboard/remote/send", {
    threadId: "thread-a",
    text: "hello",
    clientUserMessageId: "selection",
    model: "new",
    effort: "high",
  });
  const sent = f.requests.find((r) => r.method === "thread-follower-start-turn");
  assert.deepEqual(sent.params.turnStart.request.collaborationMode, {
    mode: "plan",
    settings: { model: "new", reasoning_effort: "high", developer_instructions: "retain" },
  });
});

test("remote input answers include every question and approval choices follow the live request", async (t) => {
  const f = await fixture(t, {
    initialState: {
      requests: [
        {
          id: "questions",
          method: "item/tool/requestUserInput",
          params: { questions: [{ id: "first" }, { id: "second" }] },
        },
        {
          id: "file",
          method: "item/fileChange/requestApproval",
          params: { availableDecisions: ["decline"] },
        },
      ],
    },
  });
  await assert.rejects(
    f.session.request("taskboard/remote/respond", {
      threadId: "thread-a",
      requestId: "questions",
      answers: { first: ["one"] },
    }),
    /全部问题/,
  );
  await f.session.request("taskboard/remote/respond", {
    threadId: "thread-a",
    requestId: "questions",
    answers: { first: ["one"], second: ["two"] },
  });
  assert.deepEqual(f.requests.at(-1).params.response, {
    answers: { first: { answers: ["one"] }, second: { answers: ["two"] } },
  });
  await assert.rejects(
    f.session.request("taskboard/remote/respond", {
      threadId: "thread-a",
      requestId: "file",
      decision: "accept",
    }),
    /不支持此决定/,
  );
  await f.session.request("taskboard/remote/respond", {
    threadId: "thread-a",
    requestId: "file",
    decision: "decline",
  });
  assert.equal(f.requests.at(-1).method, "thread-follower-file-approval-decision");
});

test("remote answers only current approvals and stops only the expected active turn", async (t) => {
  const f = await fixture(t, { autoComplete: false });
  await f.session.request("taskboard/remote/send", {
    threadId: "thread-a",
    text: "hello",
    clientUserMessageId: "remote-3",
  });
  await assert.rejects(
    f.session.request("taskboard/remote/respond", {
      threadId: "thread-a",
      requestId: "missing",
      decision: "accept",
    }),
  );
  await assert.rejects(
    f.session.request("taskboard/remote/stop", {
      threadId: "thread-a",
      turnId: "old",
    }),
  );
  await f.session.request("taskboard/remote/stop", { threadId: "thread-a", turnId: "turn-new" });
  assert.equal(f.requests.at(-1).params.expectedTurnId, "turn-new");
});

async function fixture(
  t,
  {
    canonical = false,
    autoComplete = true,
    rejectMethod,
    rejectError = "secret diagnostic /private/path bearer-token",
    rejectClientId = "owner",
    dropMethod,
    timeoutMs = 1000,
    initialState = {},
    hydratedState,
    historyDelayMs = 0,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "desktop-session-"));
  const socketPath = bridgeSocketPath(directory);
  const requests = [],
    messages = [],
    disconnects = [];
  let peer,
    follower,
    currentState = initialState,
    currentRevision = 0;
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    peer.write(Buffer.concat([prefix, body]));
  };
  const snapshot = (state, revision = 1) => {
    currentState = state;
    currentRevision = revision;
    send({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner",
      params: {
        hostId: "local",
        conversationId: "thread-a",
        change: {
          type: "snapshot",
          revision,
          conversationState: {
            id: "thread-a",
            cwd: "/recent",
            requests: [],
            turns: [],
            threadRuntimeStatus: { type: "idle" },
            ...state,
            ...(canonical
              ? {
                  turns: [],
                  turnHistory: {
                    kind: "canonical",
                    history: {
                      entitiesByKey: Object.fromEntries(
                        (state.turns ?? []).map((t) => [`turn:${t.turnId}`, t]),
                      ),
                    },
                  },
                }
              : {}),
          },
        },
      },
    });
  };
  const server = createServer((socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE(),
          m = JSON.parse(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
        requests.push(m);
        if (m.type === "broadcast") {
          if (m.method === "thread-stream-following-changed" && m.params.following) {
            follower = m.sourceClientId;
            snapshot(initialState);
          }
          continue;
        }
        if (m.method === dropMethod) continue;
        if (m.method === rejectMethod) {
          send({
            type: "response",
            requestId: m.requestId,
            method: m.method,
            resultType: "error",
            error: rejectError,
            handledByClientId: rejectClientId,
          });
          continue;
        }
        if (m.method === "thread-follower-set-queued-follow-ups-state")
          writeFileSync(
            join(directory, ".codex-global-state.json"),
            JSON.stringify({ "queued-follow-ups": m.params.state }),
          );
        let result = {};
        if (m.method === "initialize") result = { clientId: "follower" };
        if (m.method === "thread-follower-load-complete-history") {
          const targetRevision = currentRevision + 1;
          const next = hydratedState ?? currentState;
          result = { revision: targetRevision };
          if (historyDelayMs) setTimeout(() => snapshot(next, targetRevision), historyDelayMs);
          else snapshot(next, targetRevision);
        }
        if (m.method === "thread-follower-steer-turn") result = { result: { turnId: "running" } };
        if (m.method === "turn/start") throw new Error("must not send raw turn/start to IPC");
        if (m.method === "thread-follower-start-turn") {
          result = { result: { turn: { id: "turn-new", status: "inProgress" } } };
          // Completion may arrive before the submission response.
          snapshot(
            {
              turns: [
                {
                  turnId: "old",
                  status: "completed",
                  items: [{ id: "old-message", type: "agentMessage", text: "old" }],
                },
                {
                  turnId: "turn-new",
                  status: autoComplete ? "completed" : "inProgress",
                  items: [
                    { id: "answer", type: "agentMessage", phase: "final_answer", text: "done" },
                  ],
                },
              ],
            },
            2,
          );
        }
        send({
          type: "response",
          requestId: m.requestId,
          method: m.method,
          resultType: "success",
          handledByClientId: "owner",
          result,
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(
    join(directory, ".codex-global-state.json"),
    JSON.stringify({ "queued-follow-ups": {} }),
  );
  const session = await connectDesktopSession({
    codexHome: directory,
    socketPath,
    threadId: "thread-a",
    onMessage: (m) => messages.push(m),
    onDisconnect: (turnId) => disconnects.push(turnId),
    timeoutMs,
  });
  t.after(() => session.stop());
  return {
    directory,
    session,
    requests,
    messages,
    disconnects,
    send,
    snapshot,
    get follower() {
      return follower;
    },
  };
}

test("continues through the Desktop owner and delivers only this turn, including early completion", async (t) => {
  const f = await fixture(t);
  const result = await f.session.request("turn/start", {
    threadId: "thread-a",
    cwd: "/recent",
    clientUserMessageId: "job-a",
    input: [{ type: "text", text: "hello" }],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
  assert.equal(result.turn.id, "turn-new");
  assert.equal(
    f.messages.find((m) => m.method === "item/completed").params.item.phase,
    "final_answer",
  );
  assert.equal(f.messages.filter((m) => m.method === "turn/completed").length, 1);
  assert.deepEqual(
    f.messages.filter((m) => m.method === "item/completed").map((m) => m.params.item.text),
    ["done"],
  );
  const forwarded = f.requests.find((m) => m.method === "thread-follower-start-turn");
  assert.equal(forwarded.targetClientId, "owner");
  assert.equal(forwarded.params.turnStart.request.cwd, "/recent");
  assert.equal(forwarded.params.turnStart.request.clientUserMessageId, "job-a");
  assert.deepEqual(forwarded.params.turnStart.request.input[0].text_elements, []);
  await f.session.stop();
});

for (const serviceTier of [null, "priority"]) {
  test(`task model settings override collaboration defaults, tier=${serviceTier}`, async (t) => {
    const collaboration = {
      mode: "default",
      settings: { model: "old", reasoning_effort: "low", developer_instructions: "preserve" },
    };
    const f = await fixture(t, {
      initialState: { latestThreadSettings: { collaborationMode: collaboration } },
    });
    await f.session.request("turn/start", {
      threadId: "thread-a",
      cwd: "/recent",
      input: [{ type: "text", text: "task" }],
      model: "chosen",
      effort: "high",
      serviceTier,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    const sent = f.requests.find((m) => m.method === "thread-follower-start-turn").params.turnStart
      .request;
    assert.equal(sent.model, "chosen");
    assert.equal(sent.effort, "high");
    assert.equal(sent.serviceTier, serviceTier);
    assert.deepEqual(sent.collaborationMode, {
      mode: "default",
      settings: { model: "chosen", reasoning_effort: "high", developer_instructions: "preserve" },
    });
    assert.equal(sent.approvalsReviewer, "user");
  });
}

test("forwards approval responses and interruption to the same owner without stopping Desktop", async (t) => {
  const f = await fixture(t);
  await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
  await f.session.request("turn/interrupt", { threadId: "thread-a", turnId: "turn-new" });
  assert.deepEqual(f.requests.find((m) => m.method === "thread-follower-interrupt-turn").params, {
    conversationId: "thread-a",
    mode: "user-stop",
    expectedTurnId: "turn-new",
  });
});

test("reads canonical Desktop history instead of mistaking its empty legacy turns array for no result", async (t) => {
  const f = await fixture(t, { canonical: true });
  await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
  assert.equal(f.messages.filter((m) => m.method === "turn/completed").length, 1);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected Desktop event was not delivered");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("round-trips command, file, permissions and user input approvals for the active turn", async (t) => {
  const f = await fixture(t, { autoComplete: false });
  await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
  const cases = [
    [
      "item/commandExecution/requestApproval",
      "thread-follower-command-approval-decision",
      { decision: "decline" },
      "decision",
      "decline",
    ],
    [
      "item/fileChange/requestApproval",
      "thread-follower-file-approval-decision",
      { decision: "accept" },
      "decision",
      "accept",
    ],
    [
      "item/permissions/requestApproval",
      "thread-follower-permissions-request-approval-response",
      { permissions: {}, scope: "turn" },
      "response",
      { permissions: {}, scope: "turn" },
    ],
    [
      "item/tool/requestUserInput",
      "thread-follower-submit-user-input",
      { answers: { q: { answers: ["yes"] } } },
      "response",
      { answers: { q: { answers: ["yes"] } } },
    ],
    [
      "mcpServer/elicitation/request",
      "thread-follower-submit-mcp-server-elicitation-response",
      { action: "cancel", content: null },
      "response",
      { action: "cancel", content: null },
    ],
  ];
  f.snapshot(
    {
      turns: [{ turnId: "turn-new", status: "inProgress", items: [] }],
      requests: cases.map(([method], i) => ({
        id: i,
        method,
        params: { threadId: "thread-a", turnId: "turn-new" },
      })),
    },
    3,
  );
  await waitFor(() => f.messages.filter((m) => "id" in m).length === cases.length);
  for (const [i, [, method, result, field, value]] of cases.entries()) {
    await f.session.write({ id: i, result });
    const forwarded = f.requests.find((m) => m.method === method);
    assert.equal(forwarded.targetClientId, "owner");
    assert.deepEqual(forwarded.params, {
      conversationId: "thread-a",
      requestId: i,
      [field]: value,
    });
  }
  assert.equal(
    f.messages.some((m) => m.method === "turn/completed"),
    false,
  );
});

test("desktop-resolved approvals release the board waiter and late responses preserve completion", async (t) => {
  const f = await fixture(t, { autoComplete: false });
  await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
  const turn = { turnId: "turn-new", status: "inProgress", items: [] };
  f.snapshot(
    {
      turns: [turn],
      requests: [
        {
          id: 12,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-a", turnId: "turn-new" },
        },
      ],
    },
    3,
  );
  await waitFor(() => f.messages.some((m) => m.id === 12));
  f.snapshot({ turns: [turn], requests: [] }, 4);
  await waitFor(() => f.messages.some((m) => m.method === "serverRequest/resolved"));
  await f.session.write({ id: 12, error: { code: -32603, message: "already handled" } });
  f.snapshot(
    {
      turns: [
        {
          ...turn,
          status: "completed",
          items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "done" }],
        },
      ],
    },
    5,
  );
  await waitFor(() => f.messages.some((m) => m.method === "turn/completed"));
  assert.deepEqual(f.disconnects, []);
  assert.equal(
    f.requests.filter((m) => m.method === "thread-follower-command-approval-decision").length,
    0,
  );
  assert.equal(f.messages.filter((m) => m.method === "serverRequest/resolved").length, 1);
});

test("applies streamed canonical patches and emits completion once", async (t) => {
  const f = await fixture(t, { canonical: true, autoComplete: false });
  await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
  const message = {
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner",
    params: {
      hostId: "local",
      conversationId: "thread-a",
      change: {
        type: "patches",
        baseRevision: 2,
        revision: 3,
        patches: [
          {
            op: "replace",
            path: ["turnHistory", "history", "entitiesByKey", "turn:turn-new", "status"],
            value: "completed",
          },
        ],
      },
    },
  };
  f.send({ ...message, sourceClientId: "unrelated-owner" });
  f.send(message);
  await waitFor(() => f.messages.some((m) => m.method === "turn/completed"));
  assert.equal(f.messages.filter((m) => m.method === "turn/completed").length, 1);
  assert.equal(f.messages.find((m) => m.method === "item/completed").params.item.text, "done");
});

test("does not start another turn while Desktop is already running", async (t) => {
  const f = await fixture(t, { autoComplete: false });
  await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
  await assert.rejects(
    f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] }),
    /正在执行/,
  );
  assert.equal(f.requests.filter((m) => m.method === "thread-follower-start-turn").length, 1);
});

for (const failure of ["reject", "timeout"]) {
  test(`approval ${failure} terminates the local session without leaking diagnostics or hanging`, async (t) => {
    const method = "thread-follower-command-approval-decision";
    const f = await fixture(t, {
      autoComplete: false,
      timeoutMs: 100,
      ...(failure === "reject" ? { rejectMethod: method } : { dropMethod: method }),
    });
    await f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] });
    f.snapshot(
      {
        turns: [{ turnId: "turn-new", status: "inProgress", items: [] }],
        requests: [
          {
            id: 12,
            method: "item/commandExecution/requestApproval",
            params: { threadId: "thread-a", turnId: "turn-new" },
          },
        ],
      },
      3,
    );
    await waitFor(() => f.messages.some((m) => m.id === 12));
    await assert.rejects(f.session.write({ id: 12, result: { decision: "decline" } }), (error) => {
      assert.doesNotMatch(error.message, /secret|private|bearer-token/);
      return true;
    });
    assert.deepEqual(f.disconnects, ["turn-new"]);
  });
}

test("does not expose Desktop rejection details in an RPC error", async (t) => {
  const f = await fixture(t, { rejectMethod: "thread-follower-start-turn" });
  await assert.rejects(
    f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] }),
    (error) => {
      assert.doesNotMatch(JSON.stringify(error.rpcError), /secret|private|bearer-token/);
      return true;
    },
  );
});

test("does not dispatch a second start while the first IPC submission is pending", async (t) => {
  const f = await fixture(t, { dropMethod: "thread-follower-start-turn", timeoutMs: 100 });
  const first = f.session.request("turn/start", {
    threadId: "thread-a",
    cwd: "/recent",
    input: [],
  });
  const rejectedFirst = assert.rejects(first, /超时/);
  await assert.rejects(
    f.session.request("turn/start", { threadId: "thread-a", cwd: "/recent", input: [] }),
    (error) => error.rpcError.code === -32002,
  );
  await rejectedFirst;
  assert.equal(f.requests.filter((m) => m.method === "thread-follower-start-turn").length, 1);
});

test("reconnected interruption binds the original turn and emits its completion", async (t) => {
  const f = await fixture(t);
  await f.session.request("thread/resume", { threadId: "thread-a" });
  await f.session.request("turn/interrupt", { threadId: "thread-a", turnId: "original-turn" });
  f.snapshot({ turns: [{ turnId: "original-turn", status: "interrupted", items: [] }] }, 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.messages.filter((m) => m.method === "turn/completed").length, 1);
  assert.equal(
    f.messages.find((m) => m.method === "turn/completed").params.turn.id,
    "original-turn",
  );
});

for (const tier of [null, "priority"]) {
  test(`remote speed ${tier} stays on the original owner with explicit Astra medium`, async (t) => {
    const f = await fixture(t);
    await f.session.request("taskboard/remote/send", {
      threadId: "thread-a",
      text: "hello",
      clientUserMessageId: "speed",
      model: "gpt-6-astra",
      effort: "medium",
      serviceTier: tier,
    });
    const sent = f.requests.find((r) => r.method === "thread-follower-start-turn");
    assert.equal(sent.params.turnStart.request.serviceTier, tier);
    assert.equal(sent.params.turnStart.request.model, "gpt-6-astra");
    assert.equal(sent.params.turnStart.request.effort, "medium");
    assert.deepEqual(sent.params.turnStart.context, {
      inheritThreadSettings: true,
      threadStartKind: "default",
    });
    assert.equal(
      f.requests.some((r) => r.method === "thread/resume" || r.method === "turn/start"),
      false,
    );
  });
}

test("remote queue retains uploaded images and validates ownership before writing to Desktop", async (t) => {
  const f = await fixture(t, {
    initialState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
  });
  const ownerKey = "a".repeat(64),
    imageId = "44444444-4444-4444-8444-444444444444";
  await storeRemoteUpload(f.directory, {
    ownerKey,
    id: imageId,
    name: "screen.png",
    mimeType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=",
  });
  const read = () => f.session.request("taskboard/remote/read", { threadId: "thread-a" });
  const action = {
    threadId: "thread-a",
    operation: "append",
    text: "",
    attachments: [imageId],
    ownerKey,
    turnId: "running",
    queueToken: (await read()).remoteQueue.token,
    clientUserMessageId: "queued-image",
  };
  await assert.rejects(
    f.session.request("taskboard/remote/queue", { ...action, ownerKey: "b".repeat(64) }),
  );
  assert.equal(
    f.requests.some((r) => r.method === "thread-follower-set-queued-follow-ups-state"),
    false,
  );
  await f.session.request("taskboard/remote/queue", action);
  const write = f.requests.find((r) => r.method === "thread-follower-set-queued-follow-ups-state");
  const message = write.params.state["thread-a"][0];
  assert.match(message.context.prompt, /screen.png/);
  assert.equal(message.context.imageAttachments.length, 1);
  assert.equal(
    message.context.imageAttachments[0].src,
    message.context.imageAttachments[0].localPath,
  );
  assert.match(message.context.imageAttachments[0].localPath, /remote-uploads/);
  const view = (await read()).remoteQueue.messages[0];
  assert.equal(view.canEdit, true);
  assert.equal(view.canSteer, true);
  assert.equal(view.text, "");
  assert.equal(view.attachments[0].id, imageId);
  assert.equal(JSON.stringify(view).includes(f.directory), false);
  await f.session.request("taskboard/remote/queue", {
    threadId: "thread-a",
    operation: "edit",
    messageId: message.id,
    text: "修改后的截图说明",
    queueToken: (await read()).remoteQueue.token,
  });
  const edited = (await read()).remoteQueue.messages[0];
  assert.equal(edited.text, "修改后的截图说明");
  assert.deepEqual(edited.attachments, view.attachments);
  assert.equal(
    f.requests.some((r) => /start-turn|steer-turn|interrupt/.test(r.method)),
    false,
  );
  await f.session.request("taskboard/remote/queue", {
    threadId: "thread-a",
    operation: "steer",
    messageId: message.id,
    turnId: "running",
    queueToken: (await read()).remoteQueue.token,
  });
  const steered = f.requests.find((r) => r.method === "thread-follower-steer-turn");
  assert.match(steered.params.input[0].text, /修改后的截图说明/);
  assert.deepEqual(steered.params.input[1], {
    type: "localImage",
    path: message.context.imageAttachments[0].localPath,
  });
  assert.deepEqual(
    steered.params.restoreMessage.context.imageAttachments,
    message.context.imageAttachments,
  );
  assert.deepEqual((await read()).remoteQueue.messages, []);
});

for (const operation of ["take", "steer"]) {
  test(`remote attachment queue ${operation} retains documents and rejects changed files before removal`, async (t) => {
    const f = await fixture(t, {
      initialState: { turns: [{ turnId: "running", status: "inProgress", items: [] }] },
    });
    const ownerKey = "a".repeat(64),
      id = "55555555-5555-4555-8555-555555555555";
    await storeRemoteUpload(f.directory, {
      ownerKey,
      id,
      name: "notes.txt",
      mimeType: "text/plain",
      base64: Buffer.from("notes").toString("base64"),
    });
    const read = () => f.session.request("taskboard/remote/read", { threadId: "thread-a" });
    await f.session.request("taskboard/remote/queue", {
      threadId: "thread-a",
      operation: "append",
      text: "review notes",
      attachments: [id],
      ownerKey,
      turnId: "running",
      queueToken: (await read()).remoteQueue.token,
      clientUserMessageId: "queued-doc",
    });
    const queue = (await read()).remoteQueue;
    assert.equal(queue.messages[0].canEdit, true);
    assert.equal(queue.messages[0].attachments[0].name, "notes.txt");
    const action = {
      threadId: "thread-a",
      operation,
      messageId: "queued-doc",
      turnId: "running",
      queueToken: queue.token,
    };
    const path = join(f.directory, "taskboard", "remote-uploads", ownerKey, id, "attachment");
    writeFileSync(path, "other");
    await assert.rejects(f.session.request("taskboard/remote/queue", action), /改变/);
    assert.equal((await read()).remoteQueue.messages.length, 1);
    writeFileSync(path, "notes");
    await f.session.request("taskboard/remote/queue", action);
    assert.equal((await read()).remoteQueue.messages.length, 0);
    if (operation === "steer") {
      const sent = f.requests.find((r) => r.method === "thread-follower-steer-turn");
      assert.match(sent.params.input[0].text, /notes.txt/);
      assert.match(sent.params.input[0].text, /review notes/);
      assert.equal(sent.params.restoreMessage.context.prompt, sent.params.input[0].text);
    }
  });
}

test("Remote MCP approval forwards only to the owner and rejects stale or repeated decisions", async (t) => {
  const params = {
    mode: "form",
    serverName: "computer-use",
    message: "Allow app?",
    requestedSchema: { type: "object", properties: {} },
    _meta: { persist: ["always"] },
  };
  const f = await fixture(t, {
    initialState: {
      requests: [{ id: "app-approval", method: "mcpServer/elicitation/request", params }],
    },
  });
  const action = {
    threadId: "thread-a",
    requestId: "app-approval",
    approvalChoice: "always",
    content: {},
    approvalToken: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
  };
  await assert.rejects(
    f.session.request("taskboard/remote/respond", { ...action, approvalToken: "0".repeat(64) }),
    /变化/,
  );
  await f.session.request("taskboard/remote/respond", action);
  const sent = f.requests.filter(
    (r) => r.method === "thread-follower-submit-mcp-server-elicitation-response",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetClientId, "owner");
  assert.deepEqual(sent[0].params.response, {
    action: "accept",
    content: {},
    _meta: { persist: "always" },
  });
  await assert.rejects(f.session.request("taskboard/remote/respond", action), /处理|过期/);
  assert.equal(
    f.requests.some((r) => /resume|start-turn|interrupt|update-thread-settings/.test(r.method)),
    false,
  );
});

test("MCP approval timeout never retries or starts another owner", async (t) => {
  const method = "thread-follower-submit-mcp-server-elicitation-response";
  const params = { mode: "form", requestedSchema: { type: "object", properties: {} } };
  const f = await fixture(t, {
    timeoutMs: 30,
    dropMethod: method,
    initialState: { requests: [{ id: "mcp", method: "mcpServer/elicitation/request", params }] },
  });
  const action = {
    threadId: "thread-a",
    requestId: "mcp",
    approvalToken: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
    approvalChoice: "accept",
    content: {},
  };
  await assert.rejects(f.session.request("taskboard/remote/respond", action), /超时/);
  await assert.rejects(f.session.request("taskboard/remote/respond", action), /处理|过期/);
  assert.equal(f.requests.filter((r) => r.method === method).length, 1);
  assert.equal(
    f.requests.some((r) => /resume|start-turn|interrupt/.test(r.method)),
    false,
  );
});

test("a verified pre-dispatch owner rejection permits a fresh user submission", async (t) => {
  const method = "thread-follower-submit-mcp-server-elicitation-response";
  const params = {
    mode: "form",
    requestedSchema: { type: "object", properties: { value: { type: "string" } } },
  };
  const f = await fixture(t, {
    rejectMethod: method,
    rejectError: "Unsafe MCP server elicitation approval",
    initialState: { requests: [{ id: "mcp", method: "mcpServer/elicitation/request", params }] },
  });
  const action = {
    threadId: "thread-a",
    requestId: "mcp",
    approvalToken: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
    approvalChoice: "accept",
    content: { value: "before" },
  };
  await assert.rejects(f.session.request("taskboard/remote/respond", action));
  await assert.rejects(
    f.session.request("taskboard/remote/respond", { ...action, content: { value: "corrected" } }),
  );
  assert.equal(f.requests.filter((r) => r.method === method).length, 2);
});

for (const rejection of [
  { rejectError: "unknown owner failure", rejectClientId: "owner" },
  { rejectError: "Unsafe MCP server elicitation approval", rejectClientId: "other" },
]) {
  test(`unverified rejection retains duplicate guard: ${rejection.rejectClientId} / ${rejection.rejectError}`, async (t) => {
    const method = "thread-follower-submit-mcp-server-elicitation-response";
    const params = { mode: "form", requestedSchema: { type: "object", properties: {} } };
    const f = await fixture(t, {
      ...rejection,
      rejectMethod: method,
      initialState: { requests: [{ id: "mcp", method: "mcpServer/elicitation/request", params }] },
    });
    const action = {
      threadId: "thread-a",
      requestId: "mcp",
      approvalToken: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
      approvalChoice: "accept",
      content: {},
    };
    await assert.rejects(f.session.request("taskboard/remote/respond", action));
    await assert.rejects(f.session.request("taskboard/remote/respond", action), /处理|过期/);
    assert.equal(f.requests.filter((r) => r.method === method).length, 1);
    assert.equal(
      f.requests.some((r) => /resume|start-turn|interrupt/.test(r.method)),
      false,
    );
  });
}

for (const status of ["inProgress", "completed"]) {
  test(`async answers use Desktop reply encoding on ${status} owner without interrupting`, async (t) => {
    const item = {
      id: "async-q",
      type: "agentMessage",
      delivery: "async",
      text: "请选择",
      questions: [{ title: "入口", options: ["相册", "文件"] }],
    };
    const f = await fixture(t, {
      initialState: { turns: [{ turnId: "running", status, items: [item] }] },
    });
    const id = JSON.stringify(["request_user_input_async", "async-q", 0]);
    await f.session.request("taskboard/remote/answer", {
      threadId: "thread-a",
      itemId: "async-q",
      answers: { [id]: "相册" },
      clientUserMessageId: "answer-one",
    });
    const method =
      status === "inProgress" ? "thread-follower-steer-turn" : "thread-follower-start-turn";
    const call = f.requests.find((r) => r.method === method);
    assert.equal(call.targetClientId, "owner");
    const input = call.params.input ?? call.params.turnStart.request.input;
    assert.match(input[0].text, /^<send_user_message_question_reply>\n/);
    const payload = JSON.parse(input[0].text.split("\n")[1]);
    assert.deepEqual(payload, [{ questionItemId: id, question: "入口", answer: "相册" }]);
    assert.equal(
      f.requests.some((r) => /interrupt|resume|rollback|update-thread-settings/.test(r.method)),
      false,
    );
  });
}
test("async answers reject missing questions and blank answers before IPC", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.session.request("taskboard/remote/answer", {
      threadId: "thread-a",
      itemId: "missing",
      answers: { x: "yes" },
      clientUserMessageId: "bad",
    }),
    /问题/,
  );
  assert.equal(
    f.requests.some((r) => r.method === "thread-follower-start-turn"),
    false,
  );
});
test("edit validates the latest stopped turn and delegates attachment-preserving edit to the owner", async (t) => {
  const candidate = {
    turnId: "stopped",
    itemId: "remote-input:stopped",
    input: [
      { type: "text", text: "原消息" },
      { type: "localImage", path: "/original.png" },
    ],
  };
  const f = await fixture(t, {
    initialState: {
      turns: [
        { turnId: "stopped", status: "interrupted", params: { input: candidate.input }, items: [] },
      ],
    },
  });
  const editToken = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
  await assert.rejects(
    f.session.request("taskboard/remote/edit", {
      threadId: "thread-a",
      turnId: "stale",
      editToken,
      text: "修改",
    }),
    /变化/,
  );
  await f.session.request("taskboard/remote/edit", {
    threadId: "thread-a",
    turnId: "stopped",
    editToken,
    text: "修改后的消息",
  });
  const call = f.requests.find((r) => r.method === "thread-follower-edit-last-user-turn");
  assert.equal(call.version, 2);
  assert.equal(call.targetClientId, "owner");
  assert.deepEqual(call.params, {
    conversationId: "thread-a",
    turnId: "stopped",
    message: "修改后的消息",
    shouldSendPermissionOverrides: false,
  });
  assert.equal(
    f.requests.some((r) => /interrupt|resume|rollback|thread-follower-start-turn/.test(r.method)),
    false,
  );
});
test("edit refuses to overwrite a running turn", async (t) => {
  const f = await fixture(t, {
    initialState: {
      turns: [
        {
          turnId: "running",
          status: "inProgress",
          params: { input: [{ type: "text", text: "original" }] },
          items: [],
        },
      ],
    },
  });
  await assert.rejects(
    f.session.request("taskboard/remote/edit", {
      threadId: "thread-a",
      turnId: "running",
      editToken: "a".repeat(64),
      text: "new",
    }),
    /停止/,
  );
  assert.equal(
    f.requests.some((r) => r.method === "thread-follower-edit-last-user-turn"),
    false,
  );
});

for (const reviewer of ["auto_review", "user"]) {
  test(`task turns inherit the owner's ${reviewer} permissions without overrides`, async (t) => {
    const f = await fixture(t, {
      initialState: {
        latestThreadSettings: {
          approvalPolicy: "on-request",
          approvalsReviewer: reviewer,
          sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        },
      },
    });
    await f.session.request("thread/resume", { threadId: "thread-a", cwd: "/recent" });
    await f.session.request("turn/start", {
      threadId: "thread-a",
      cwd: "/recent",
      input: [{ type: "text", text: "task" }],
    });
    const forwarded = f.requests.find((r) => r.method === "thread-follower-start-turn");
    assert.equal(forwarded.targetClientId, "owner");
    assert.equal(forwarded.params.turnStart.context.inheritThreadSettings, true);
    for (const key of ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"])
      assert.equal(Object.hasOwn(forwarded.params.turnStart.request, key), false);
    assert.equal(
      f.requests.some((r) => /resume|interrupt|update-thread-settings/.test(r.method)),
      false,
    );
  });
}

for (const method of ["taskboard/remote/send", "turn/start"]) {
  for (const [name, initialState, expected] of [
    ["new draft", {}, "default"],
    ["named draft", { title: "User title" }, undefined],
    [
      "existing history",
      { turns: [{ turnId: "previous", status: "completed", items: [] }] },
      undefined,
    ],
    ["explicit kind", { threadStartKind: "review" }, "review"],
  ]) {
    test(`${method} preserves Desktop title generation for ${name}`, async (t) => {
      const f = await fixture(t, { initialState });
      await f.session.request(method, {
        threadId: "thread-a",
        cwd: "/recent",
        text: "Fix title synchronization",
        clientUserMessageId: "title-test",
        input: [{ type: "text", text: "Fix title synchronization", text_elements: [] }],
      });
      const sent = f.requests.filter((r) => r.method === "thread-follower-start-turn");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].targetClientId, "owner");
      assert.equal(sent[0].params.turnStart.context.threadStartKind, expected);
      assert.equal(
        f.requests.some((r) => /thread\/resume|thread\/name\/set|thread\/start/.test(r.method)),
        false,
      );
    });
  }
}
