import assert from "node:assert/strict";
import test from "node:test";
import { loadDesktopSession, openDesktopThread } from "./codex-desktop-loader.mjs";

const threadId = "01a081e6-d8a9-7641-97b3-89adb4f36308";
const unavailable = () => Object.assign(new Error("unavailable"), { rpcError: { code: -32001 } });

test("uses the existing owner without opening Desktop or sending a turn", async () => {
  const session = {};
  assert.equal(
    await loadDesktopSession({
      threadId,
      connector: async () => session,
      opener: () => assert.fail("unexpected open"),
    }),
    session,
  );
});

test("waits for a large existing-owner snapshot without reopening Desktop", async () => {
  const session = {};
  let opens = 0;
  const loaded = await loadDesktopSession({
    threadId,
    connector: ({ connectTimeoutMs, signal }) =>
      new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(snapshot);
          clearTimeout(deadline);
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(session);
        };
        const abort = () => finish(unavailable());
        const snapshot = setTimeout(() => finish(), 1500);
        const deadline = setTimeout(() => finish(unavailable()), connectTimeoutMs);
        signal.addEventListener("abort", abort, { once: true });
      }),
    opener: () => {
      opens++;
      throw new Error("The existing owner is already responding");
    },
  });
  assert.equal(loaded, session);
  assert.equal(opens, 0);
});

test("opens once after discovery failure and retries only the connection", async () => {
  let attempts = 0,
    opens = 0;
  const session = {};
  assert.equal(
    await loadDesktopSession({
      threadId,
      retryMs: 1,
      connector: async () => {
        if (++attempts < 3) throw unavailable();
        return session;
      },
      opener: async (id) => {
        assert.equal(id, threadId);
        opens++;
      },
    }),
    session,
  );
  assert.equal(attempts, 3);
  assert.equal(opens, 1);
});

test("loading failure is bounded and does not expose native diagnostics", async () => {
  const started = performance.now();
  await assert.rejects(
    loadDesktopSession({
      threadId,
      timeoutMs: 30,
      retryMs: 1,
      connector: async () => {
        throw unavailable();
      },
      opener: async () => {},
    }),
    (error) => error.rpcError?.code === -32001,
  );
  assert.ok(performance.now() - started < 300);
  await assert.rejects(
    loadDesktopSession({
      threadId,
      connector: async () => {
        throw unavailable();
      },
      opener: async () => {
        throw new Error("private diagnostic");
      },
    }),
    (error) => !error.message.includes("private diagnostic"),
  );
});

test("does not reopen a discovered owner when its large snapshot times out", async () => {
  let attempts = 0;
  await assert.rejects(
    loadDesktopSession({
      threadId,
      connector: async ({ connectTimeoutMs, snapshotTimeoutMs }) => {
        attempts++;
        assert.ok(snapshotTimeoutMs > connectTimeoutMs);
        throw Object.assign(new Error("history timeout"), { rpcError: { code: -32003 } });
      },
      opener: () => assert.fail("must not restart the same snapshot by opening Desktop"),
    }),
    /history timeout/,
  );
  assert.equal(attempts, 1);
});

test("rejects nonpersistent ids before opening an application", async () => {
  await assert.rejects(openDesktopThread("x; touch /tmp/invalid"), /编号/);
});

test("a short discovery probe loads once without shortening the snapshot deadline", async () => {
  let attempts = 0,
    opens = 0;
  const session = {};
  const started = Date.now();
  const result = await loadDesktopSession({
    threadId,
    discoveryTimeoutMs: 30,
    connector: async ({ discoveryTimeoutMs, snapshotTimeoutMs }) => {
      assert.ok(snapshotTimeoutMs > discoveryTimeoutMs);
      if (++attempts === 1) {
        await new Promise((r) => setTimeout(r, discoveryTimeoutMs));
        throw unavailable();
      }
      return session;
    },
    opener: async () => {
      opens++;
    },
    retryMs: 1,
  });
  assert.equal(result, session);
  assert.equal(opens, 1);
  assert.ok(Date.now() - started < 1000);
});

test("Windows opens only the validated deep link without a command shell or a new turn", async () => {
  let call;
  await openDesktopThread(threadId, {
    platform: "win32",
    execute: (command, args, options, callback) => {
      call = { command, args, options };
      callback(null);
    },
  });
  assert.equal(call.command, "powershell.exe");
  assert.match(call.args.at(-1), new RegExp(`codex://threads/${threadId}`));
  assert.doesNotMatch(call.args.join(" "), /ExecutionPolicy|Bypass|turn\/start/);
  await assert.rejects(
    openDesktopThread("id'; bad", { platform: "win32", execute: () => assert.fail() }),
    /编号/,
  );
});
