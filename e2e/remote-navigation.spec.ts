import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("initial loading does not render the project list beneath it", async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/remote/threads?*", async (route) => {
    await ready;
    await route.fulfill({ json: { data: { threads: [], nextCursor: null } } });
  });
  try {
    await page.goto("/?remote=1");
    await expect(page.getByText("正在加载任务…", { exact: true })).toBeVisible();
    await expect(page.locator(".remote-project-heading")).toHaveCount(0);
    await expect(page.locator(".remote-project-group")).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "最近", exact: true })).toBeVisible();
  await expect(page.getByText("正在加载任务…", { exact: true })).toHaveCount(0);
});

test("pagination appears only at the end of an expanded task group", async ({ page }) => {
  await page.route("**/api/v1/remote/threads?*", (route) => {
    const next = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({
      json: {
        data: {
          nextCursor: next ? null : "older",
          threads: [
            {
              id: next
                ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              title: next ? "更早的任务" : "最新的任务",
              preview: "",
              cwd: "/unassigned",
              updatedAt: next ? 1 : 2,
              status: "idle",
            },
          ],
        },
      },
    });
  });
  await page.goto("/?remote=1");
  const group = page.locator(".remote-recent-group");
  await expect(group).toBeVisible();
  await expect(page.getByRole("button", { name: "加载更多任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "展开显示" })).toHaveCount(0);
  await page.getByRole("button", { name: "最近", exact: true }).click();
  const more = group.getByRole("button", { name: "展开显示" });
  await expect(group.locator(".remote-thread-list > li").last()).toContainText("展开显示");
  await more.click();
  await expect(group.getByRole("button", { name: "更早的任务", exact: true })).toBeVisible();
  await expect(more).toHaveCount(0);
});

test("new task sends the edited first message without a second click", async ({ page }) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  const draft = page.getByRole("textbox", { name: "新任务消息" });
  await expect(draft).toBeEditable();
  await draft.fill("检查页面\n保留这份草稿");
  await draft.selectText();
  await draft.fill("修改后的新任务草稿");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".remote-user-message")).toContainText("修改后的新任务草稿");
  const id = new URL(page.url()).searchParams.get("remoteThread")!;
  expect(await page.evaluate((id) => localStorage.getItem(`remote-draft:${id}`), id)).toBe("");
  await page.reload();
  await expect(page.locator(".remote-user-message")).toHaveCount(1);
});

test("returning to projects clears keyboard offset before delayed viewport events", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("发送给 Codex").fill("保留草稿");
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => 500 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 280 });
    viewport.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".remote-page")).toHaveCSS("top", "280px");
  await page.getByRole("button", { name: "返回任务", exact: true }).click();
  await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
  await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));
  await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
  await expect(page.getByRole("heading", { name: "远程", exact: true })).toBeInViewport();
});

for (const screen of ["projects", "conversation"]) {
  test(`${screen} keeps input visible when keyboard resize leaves a stale pan`, async ({
    page,
  }, testInfo) => {
    await page.goto("/?remote=1");
    if (screen === "conversation") {
      await page.getByRole("button", { name: "新建 Codex 任务" }).click();
      await page.getByRole("button", { name: "创建", exact: true }).click();
    }
    const input =
      screen === "conversation"
        ? page.getByLabel("发送给 Codex")
        : page.locator(".remote-search input");
    await input.fill("键盘布局回归");
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "offsetTop", {
        configurable: true,
        get: () => 320,
      });
    });
    await page.setViewportSize({ width: 390, height: 430 });
    await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
    await expect(page.locator(".remote-page")).toHaveCSS("height", "430px");
    await expect(input).toBeInViewport();
    await expect(input).toHaveValue("键盘布局回归");
    const header = await page.locator(".remote-header").boundingBox();
    expect(header!.y).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`${screen}-keyboard.png`) });
    await input.evaluate((element) => element.blur());
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
    await expect
      .poll(async () => Math.abs((await page.locator(".remote-page").boundingBox())!.height - 844))
      .toBeLessThan(1);
    await input.focus();
    await expect
      .poll(async () => Math.abs((await page.locator(".remote-page").boundingBox())!.y))
      .toBeLessThan(1);
  });
}

for (const screen of ["projects", "conversation"]) {
  test(`${screen} stays anchored throughout the Feishu keyboard opening and closing animation`, async ({
    page,
  }) => {
    await page.goto("/?remote=1");
    if (screen === "conversation") {
      await page.getByRole("button", { name: "新建 Codex 任务" }).click();
      await page.getByRole("button", { name: "创建", exact: true }).click();
    }
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Lark/7.50.0",
      });
    });
    const input =
      screen === "conversation"
        ? page.getByLabel("发送给 Codex")
        : page.locator(".remote-search input");
    await input.fill("保留输入");
    // Native viewport events precede layout resize. Check every painted frame,
    // including the period when the old full-height container is still present.
    for (const [height, offset] of [
      [740, 104],
      [600, 244],
      [430, 320],
      [430, 0],
      [600, 244],
      [740, 104],
      [844, 0],
    ]) {
      const frame = await page.evaluate(
        async ({ height, offset }) => {
          const viewport = window.visualViewport!;
          Object.defineProperty(viewport, "height", { configurable: true, get: () => height });
          Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => offset });
          viewport.dispatchEvent(new Event("resize"));
          viewport.dispatchEvent(new Event("scroll"));
          await new Promise(requestAnimationFrame);
          const header = document.querySelector(".remote-header")!.getBoundingClientRect();
          const pageBounds = document.querySelector(".remote-page")!.getBoundingClientRect();
          return { top: header.top, bottom: pageBounds.bottom };
        },
        { height: height!, offset: offset! },
      );
      expect(Math.abs(frame.top)).toBeLessThan(1);
      expect(frame.bottom).toBeLessThanOrEqual(height! + 1);
    }
    await expect(input).toHaveValue("保留输入");
    await expect(input).toBeFocused();
  });
}

for (const client of ["Lark/7.50.0", "Version/18.0 Safari/605.1.15", "CriOS/140.0 Mobile"]) {
  for (const screen of ["projects", "conversation"]) {
    test(`${screen} ${client} intercepts the first iOS input tap before native reveal scrolling`, async ({
      page,
    }) => {
      await page.goto("/?remote=1");
      if (screen === "conversation") {
        await page.getByRole("button", { name: "新建 Codex 任务" }).click();
        await page.getByRole("button", { name: "创建", exact: true }).click();
      }
      const input =
        screen === "conversation"
          ? page.getByLabel("发送给 Codex")
          : page.locator(".remote-search input");
      await input.evaluate((element) => element.blur());
      await page.evaluate((client) => {
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          value: `Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 ${client}`,
        });
        document.addEventListener("touchend", (event) => {
          document.documentElement.dataset.tapPrevented = String(event.defaultPrevented);
        });
        document.querySelector(".remote-page")!.addEventListener("focusin", (event) => {
          document.documentElement.dataset.focusOpacity = getComputedStyle(
            event.target as Element,
          ).opacity;
        });
      }, client);
      await input.tap();
      await expect(input).toBeFocused();
      await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "true");
      await expect(page.locator("html")).toHaveAttribute("data-focus-opacity", "0");
      await expect(input).toHaveCSS("opacity", "1");
      await input.fill("保留草稿和光标");
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 500 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      // Let the modeled keyboard finish its opening animation before caret taps.
      await page.waitForTimeout(260);
      await input.tap();
      await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "false");
      await expect(input).toHaveValue("保留草稿和光标");
      await expect(input).toBeFocused();
      // Repeat Done/reopen with both possible WebKit behaviors: DOM focus is
      // retained, or actually blurred. Do not wait for closing animations.
      for (let cycle = 0; cycle < 12; cycle++) {
        await input.evaluate(
          (element, blur) => {
            (element as HTMLInputElement).setSelectionRange(2, 4);
            if (blur) element.blur();
            Object.defineProperty(window.visualViewport!, "height", {
              configurable: true,
              value: 844,
            });
            window.visualViewport!.dispatchEvent(new Event("resize"));
          },
          cycle % 2 === 1,
        );
        await input.tap();
        await expect(input).toBeFocused();
        await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "true");
        await expect(input).toHaveCSS("opacity", "1");
        await expect(input).toHaveValue("保留草稿和光标");
        expect(
          await input.evaluate((element) => [
            (element as HTMLInputElement).selectionStart,
            (element as HTMLInputElement).selectionEnd,
          ]),
        ).toEqual([2, 4]);
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, "height", {
            configurable: true,
            value: 500,
          });
          window.visualViewport!.dispatchEvent(new Event("resize"));
        });
      }
      await expect(page.locator(".remote-page")).toHaveCSS("top", "0px");
    });
  }
}

test("project search icon and label padding use protected focus too", async ({ page }) => {
  await page.goto("/?remote=1");
  await expect(page.locator(".remote-search input")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Lark/7.50.0",
    });
    document.addEventListener("touchend", (event) => {
      document.documentElement.dataset.tapPrevented = String(event.defaultPrevented);
    });
    document.querySelector(".remote-page")!.addEventListener("focusin", (event) => {
      document.documentElement.dataset.focusOpacity = getComputedStyle(
        event.target as Element,
      ).opacity;
    });
  });
  const input = page.getByRole("searchbox", { name: "搜索 Codex 任务" });
  for (let cycle = 0; cycle < 8; cycle++) {
    await input.evaluate((element) => element.blur());
    if (cycle % 2) await page.locator(".remote-search .sf-symbol").tap();
    else await page.locator(".remote-search").tap({ position: { x: 5, y: 25 } });
    await expect(input).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-tap-prevented", "true");
    await expect(page.locator("html")).toHaveAttribute("data-focus-opacity", "0");
    await expect(input).toHaveCSS("opacity", "1");
  }
});

test("keyboard diagnostics are opt-in and save geometry without draft contents", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await expect(page.getByRole("button", { name: "保存键盘诊断" })).toHaveCount(0);
  await page.goto("/?remote=1&keyboardDebug=1");
  await page.getByRole("searchbox", { name: "搜索 Codex 任务" }).fill("DO_NOT_COLLECT_DRAFT");
  let uploaded = "";
  await page.route("**/api/v1/remote/uploads", async (route) => {
    const body = route.request().postDataJSON();
    uploaded = Buffer.from(body.base64, "base64").toString();
    await route.fulfill({
      json: {
        data: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "keyboard-diagnostics.json",
          mimeType: "application/json",
          size: Buffer.byteLength(uploaded),
        },
      },
    });
  });
  await page.getByRole("button", { name: "保存键盘诊断" }).click();
  await expect(page.getByRole("button", { name: "诊断已保存" })).toBeVisible();
  expect(uploaded).not.toContain("DO_NOT_COLLECT_DRAFT");
  expect(JSON.parse(uploaded).records.length).toBeGreaterThan(0);
  expect(JSON.parse(uploaded).records.length).toBeLessThanOrEqual(300);
});

test("first send retry reuses the created thread and receipt", async ({ page }) => {
  let creates = 0;
  const receipts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/remote/threads")
      creates++;
  });
  await page.route("**/api/v1/remote/threads/*/actions", async (route) => {
    receipts.push(route.request().headers()["idempotency-key"]!);
    if (receipts.length === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: { code: "INVALID_REQUEST", message: "temporary failure", requestId: "test" },
        },
      });
    return route.continue();
  });
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByLabel("新任务消息").fill("只发送一次");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("新任务消息")).toHaveValue("只发送一次");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".remote-user-message")).toHaveText("只发送一次");
  expect(creates).toBe(1);
  expect(receipts).toHaveLength(2);
  expect(receipts[0]).toBe(receipts[1]);
});

test("web login leaves project and Remote controls visible and clickable", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/v1/auth/development", {
    headers: { Origin: process.env.CODEXBOARD_ORIGIN! },
  });
  const session = await login.json();
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({
      json: { data: { authMode: "web", feishuAppId: null, webLoginEnabled: true } },
    }),
  );
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "UNAUTHENTICATED", message: "login", requestId: "test" } },
    }),
  );
  await page.route("**/api/v1/auth/web/login", (route) => route.fulfill({ json: session }));
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("preview-user");
  const password = page.getByLabel("密码", { exact: true });
  await password.fill("preview-password");
  await expect(password).toHaveCSS("font-size", "16px");
  await password.press("Enter");
  const project = page.getByRole("button", { name: /切换项目，当前/ });
  await expect(project).toBeInViewport();
  await project.tap();
  await expect(page.getByRole("menu", { name: "切换项目" })).toBeVisible();
  await project.tap();
  await page.locator(".remote-entry").tap();
  await expect(page.getByRole("main", { name: "Codex Remote" })).toBeVisible();
});

test("keyboard dismissal expands Remote before the containing layout catches up", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.locator(".remote-search input").fill("keyboard");
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".application-content")!.style.cssText =
      "flex: none; height: 430px";
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, value: 740 });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, value: 0 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".remote-page")).toHaveCSS("height", "740px");
});

test("paper tasks keep Desktop assignments and activity order after a project folder rename", async ({
  page,
}) => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: projectId,
            name: "paper",
            projectKey: "PAPER",
            description: "",
            version: 1,
            membershipRole: null,
            createdAt: "2026-09-23T00:00:00.000Z",
            updatedAt: "2026-09-23T00:00:00.000Z",
            archivedAt: null,
            kind: "codex",
            syncState: "synced",
            rootPaths: ["/new/paper"],
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/remote/threads?*", (route) =>
    route.fulfill({
      json: {
        data: {
          nextCursor: null,
          threads: [
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              title: "打开过的旧任务",
              preview: "",
              cwd: "/old/codex-paper",
              updatedAt: 999,
              recencyAt: 1,
              status: "idle",
              projectId,
            },
            {
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              title: "最近活动的任务",
              preview: "",
              cwd: "/worktrees/paper",
              updatedAt: 10,
              recencyAt: 10,
              status: "idle",
              projectId,
            },
          ],
        },
      },
    }),
  );
  await page.goto("/?remote=1");
  const project = page
    .locator(".remote-project-group")
    .filter({ has: page.getByRole("button", { name: "paper", exact: true }) });
  await project.getByRole("button", { name: "paper", exact: true }).click();
  await expect(project.locator(".remote-thread-list > li").first()).toContainText("最近活动的任务");
  await expect(project.getByRole("button", { name: "打开过的旧任务", exact: true })).toBeVisible();
  await expect(project.getByText("暂无任务", { exact: true })).toHaveCount(0);
});
