import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("reopening a conversation waits for fresh data instead of rendering cached history", async ({
  page,
}) => {
  const id = "88888888-8888-4888-8888-888888888888";
  let secondVisit = false;
  let releaseRead = () => {};
  const freshRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route("**/api/v1/remote/threads?*", (route) =>
    route.fulfill({
      json: {
        data: {
          threads: [
            {
              id,
              title: "同步测试",
              preview: "",
              cwd: "/project",
              updatedAt: Date.now(),
              status: "idle",
            },
          ],
          nextCursor: null,
        },
      },
    }),
  );
  await page.route(`**/api/v1/remote/threads/${id}`, async (route) => {
    const fresh = secondVisit;
    if (fresh) await freshRead;
    await route.fulfill({
      json: {
        data: {
          id,
          title: "同步测试",
          cwd: "/project",
          model: "test",
          effort: "medium",
          status: "idle",
          activeTurnId: null,
          historyComplete: true,
          requests: [],
          turns: [
            {
              id: "turn-1",
              status: "completed",
              diff: "",
              error: "",
              items: [
                {
                  id: "message-1",
                  type: "userMessage",
                  text: fresh ? "最新消息" : "缓存里的旧消息",
                  detail: "",
                },
              ],
            },
          ],
        },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await expect(page.getByText("缓存里的旧消息", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回任务", exact: true }).tap();
  await page.getByRole("button", { name: "最近", exact: true }).tap();
  secondVisit = true;
  await page.locator(".remote-thread-list button").filter({ hasText: "同步测试" }).tap();
  try {
    await expect(page.getByText("正在连接桌面对话…", { exact: true })).toBeVisible();
    await expect(page.getByText("缓存里的旧消息", { exact: true })).toHaveCount(0);
  } finally {
    releaseRead();
  }
  await expect(page.getByText("最新消息", { exact: true })).toBeVisible();
  await expect(page.getByText("缓存里的旧消息", { exact: true })).toHaveCount(0);
});

test("a failed Desktop connection stops polling and can be retried explicitly", async ({
  page,
}) => {
  const id = "99999999-9999-4999-8999-999999999999";
  let reads = 0;
  let succeed = false;
  await page.route(`**/api/v1/remote/threads/${id}`, async (route) => {
    reads++;
    if (!succeed)
      return route.fulfill({
        status: 503,
        json: { error: { code: "REMOTE_UNAVAILABLE", message: "private diagnostic" } },
      });
    return route.fulfill({
      json: {
        data: {
          id,
          title: "恢复连接",
          cwd: "/project",
          model: "test",
          effort: "medium",
          status: "idle",
          activeTurnId: null,
          historyComplete: true,
          requests: [],
          turns: [],
        },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await expect(page.getByText("暂时无法连接桌面对话，请检查 Desktop 后重试。")).toBeVisible();
  const initialReads = reads;
  await page.waitForTimeout(2500);
  expect(reads).toBe(initialReads);
  await expect(page.getByText("正在连接桌面对话…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("数据已更新，请刷新后重试。")).toHaveCount(0);
  succeed = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "有什么需要帮忙？" })).toBeVisible();
});
