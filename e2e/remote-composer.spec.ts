import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("composer expands, selects approval and model effort, and preserves uploaded files after failure", async ({
  page,
}, testInfo) => {
  await page.route("**/api/v1/remote/models", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "test-model",
            name: "Test model",
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            defaultEffort: "medium",
          },
          {
            id: "second-model",
            name: "Second model",
            efforts: ["low", "high"],
            defaultEffort: "low",
          },
        ],
      },
    }),
  );
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "审批方式", exact: true })).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("composer-collapsed.png"),
  });
  await input.focus();
  await expect(page.locator(".remote-rich-composer")).toHaveClass(/is-expanded/);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("composer-expanded.png"),
  });
  await page.getByRole("button", { name: "审批方式", exact: true }).click();
  const permissions = page.getByRole("dialog", { name: "审批方式" });
  await expect(
    permissions.getByRole("group", { name: "审批预设" }).getByRole("button"),
  ).toHaveCount(3);
  await expect(permissions.getByRole("button", { name: "关闭提示" })).toHaveCount(0);
  await expect(permissions.getByRole("button", { name: /替我批准/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("composer-permissions.png"),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 320, height: 430 });
  await expect(permissions.getByRole("button", { name: /完全访问/ })).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("composer-permissions-dark-narrow.png"),
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await permissions.getByRole("button", { name: /请求批准/ }).click();
  await page.getByRole("button", { name: "模型与推理强度" }).click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("button", { name: "Test model", exact: true }).click();
  let previousArc = 101;
  for (const [index, name] of ["low", "medium", "high", "xhigh", "max", "ultra"].entries()) {
    await page.getByRole("slider", { name: "推理强度" }).fill(String(index));
    await expect(page.locator(".remote-effort-gauge")).toHaveAttribute("data-effort", name);
    const offset = Number(
      await page.locator(".remote-gauge-fill").getAttribute("stroke-dashoffset"),
    );
    expect(offset).toBeLessThan(previousArc);
    previousArc = offset;
    await page
      .locator(".remote-effort-gauge")
      .screenshot({ animations: "disabled", path: testInfo.outputPath(`gauge-${name}.png`) });
  }
  await page.getByRole("slider").fill("1");
  const sliderBounds = await page.getByRole("slider").boundingBox();
  const thumbX = (step: number) => sliderBounds!.x + 16 + ((sliderBounds!.width - 32) * step) / 5;
  await page.mouse.move(thumbX(1), sliderBounds!.y + sliderBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbX(3), sliderBounds!.y + sliderBounds!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("slider")).toHaveValue("3");
  await expect(page.locator(".remote-effort-gauge")).toHaveAttribute("data-effort", "xhigh");
  await page.getByRole("slider", { name: "推理强度" }).fill("2");
  await expect(page.getByRole("slider")).toHaveAttribute("aria-valuetext", "高");
  await expect(page.locator(".remote-effort-gauge")).toHaveAttribute("data-effort", "high");
  const highArc = await page.locator(".remote-gauge-fill").getAttribute("stroke-dashoffset");
  await page.getByRole("slider").fill("0");
  await expect(page.locator(".remote-effort-gauge")).toHaveAttribute("data-effort", "low");
  const lowArc = await page.locator(".remote-gauge-fill").getAttribute("stroke-dashoffset");
  expect(Number(highArc)).toBeLessThan(Number(lowArc));
  await expect(page.locator(".remote-gauge-needle")).toHaveCSS("transition-duration", "0.34s");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("button", { name: "Second model" }).click();
  await expect(page.getByRole("slider")).toHaveValue("0");
  await expect(page.locator(".remote-slider-thumb")).toHaveCSS("transition-property", "left");
  await page.getByRole("slider").fill("1");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("composer-model.png"),
  });
  await page.getByRole("button", { name: "关闭输入设置" }).click();
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加附件" }).getByRole("button")).toHaveCount(3);
  await expect(
    page
      .getByRole("dialog", { name: "添加附件" })
      .getByRole("button", { name: "附件", exact: true }),
  ).toHaveCount(0);
  const addMenu = page.getByRole("dialog", { name: "添加附件" });
  await expect(addMenu.getByRole("button", { name: "照片与视频", exact: true })).toBeVisible();
  await expect(addMenu.getByRole("button", { name: "文件", exact: true })).toBeVisible();
  const photoChooser = page.waitForEvent("filechooser");
  await addMenu.getByRole("button", { name: "照片与视频", exact: true }).click();
  expect(await (await photoChooser).element().getAttribute("aria-label")).toBe("上传照片与视频");
  const fileChooser = page.waitForEvent("filechooser");
  await addMenu.getByRole("button", { name: "文件", exact: true }).click();
  expect(await (await fileChooser).element().getAttribute("aria-label")).toBe("上传文件");
  await expect(page.getByLabel("上传照片与视频")).toHaveAttribute("accept", "image/*,video/*");
  const ios = await page.evaluate(
    () =>
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
  );
  if (ios)
    await expect(page.getByLabel("上传文件")).toHaveAttribute("accept", "application/octet-stream");
  else await expect(page.getByLabel("上传文件")).not.toHaveAttribute("accept");
  await expect(page.getByLabel("使用相机")).toHaveAttribute("capture", "environment");
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("composer-attachments.png"),
  });
  await page.getByLabel("上传文件").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("file contents"),
  });
  await expect(page.getByRole("button", { name: "移除 notes.txt" })).toBeVisible();
  await input.fill("检查附件");
  await page.route("**/api/v1/remote/threads/*/actions", (route) => {
    const action = route.request().postDataJSON();
    expect(action).toMatchObject({
      type: "send",
      text: "检查附件",
      model: "second-model",
      effort: "high",
      approvalMode: "ask",
    });
    expect(action.attachments).toHaveLength(1);
    return route.fulfill({
      status: 503,
      json: { error: { code: "INVALID_REQUEST", message: "模拟连接失败", requestId: "test" } },
    });
  });
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("服务暂时无法连接");
  await page.reload();
  await expect(input).toHaveValue("检查附件");
  await expect(page.getByRole("button", { name: "移除 notes.txt" })).toBeVisible();
});

test("touching composer tools and settings keeps the input focused until an outside tap", async ({
  page,
}) => {
  await page.route("**/api/v1/remote/models", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "test-model",
            name: "Test model",
            efforts: ["low", "medium", "high"],
            defaultEffort: "medium",
          },
        ],
      },
    }),
  );
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await input.tap();
  await input.evaluate((el) => {
    el.dataset.blurCount = "0";
    el.addEventListener("blur", () => {
      el.dataset.blurCount = String(Number(el.dataset.blurCount) + 1);
    });
  });
  await page.getByRole("button", { name: "添加附件", exact: true }).tap();
  await expect(page.getByRole("dialog", { name: "添加附件" })).toBeVisible();
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "关闭输入设置" }).tap({ position: { x: 350, y: 350 } });
  await expect(input).not.toBeFocused();
  await expect(page.locator(".remote-rich-composer")).not.toHaveClass(/is-expanded/);
  await input.tap();
  await input.evaluate((el) => {
    el.dataset.blurCount = "0";
  });
  await page.getByRole("button", { name: "审批方式", exact: true }).tap();
  await expect(input).toBeFocused();
  await page
    .getByRole("dialog", { name: "审批方式" })
    .getByRole("button", { name: /请求批准/ })
    .tap();
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "模型与推理强度" }).tap();
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "选择模型", exact: true }).tap();
  await page.getByRole("button", { name: "Test model", exact: true }).tap();
  await expect(input).toBeFocused();
  const slider = page.getByRole("slider");
  await slider.tap({ position: { x: 30, y: 17 } });
  await expect(slider).toHaveValue("0");
  await expect(input).toBeFocused();
  const box = await slider.boundingBox();
  await page.mouse.move(box!.x + 16, box!.y + 17);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 16, box!.y + 17, { steps: 6 });
  await page.mouse.up();
  await expect(slider).toHaveValue("2");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("data-blur-count", "0");
  await page.getByRole("button", { name: "关闭输入设置" }).tap({ position: { x: 350, y: 350 } });
  await expect(input).not.toBeFocused();
  await input.tap();
  await page.getByRole("heading", { name: "有什么需要帮忙？" }).tap();
  await expect(input).not.toBeFocused();
});

test("Astra medium default, reset and speed preserve focus and reach the send request", async ({
  page,
}, testInfo) => {
  await page.route("**/api/v1/remote/models", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "gpt-6-astra",
            name: "GPT-6 Astra",
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            defaultEffort: "high",
            isDefault: true,
            defaultPresets: [
              { effort: "low", order: 3 },
              { effort: "medium", order: 4 },
              { effort: "xhigh", order: 5 },
            ],
            serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
          },
          {
            id: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            efforts: ["low", "medium", "high", "xhigh"],
            defaultEffort: "medium",
            defaultPresets: [{ effort: "low", order: 0 }],
            serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
          },
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            efforts: ["low", "medium", "high", "xhigh"],
            defaultEffort: "medium",
            defaultPresets: [
              { effort: "low", order: 1 },
              { effort: "medium", order: 2 },
            ],
            serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
          },
          { id: "other", name: "Other model", efforts: ["low", "high"], defaultEffort: "low" },
        ],
      },
    }),
  );
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  const newInput = page.getByLabel("新任务消息");
  const project = page.locator(".remote-project-choice");
  const composer = page.locator(".remote-rich-composer");
  const checkLayout = async () => {
    const p = (await project.boundingBox())!;
    const c = (await composer.boundingBox())!;
    expect(p.x - c.x).toBeGreaterThanOrEqual(12);
    expect(p.x - c.x).toBeLessThanOrEqual(24);
    expect(c.y - p.y - p.height).toBeGreaterThanOrEqual(6);
    expect(c.y - p.y - p.height).toBeLessThanOrEqual(12);
  };
  await checkLayout();
  await page.screenshot({ path: testInfo.outputPath("project-collapsed.png") });
  await newInput.tap();
  await expect(composer).toHaveClass(/is-expanded/);
  await expect(composer).toHaveCSS("margin-left", "0px");
  await expect(page.locator(".remote-new-options")).toHaveCSS("padding-left", "26px");
  await checkLayout();
  await page.screenshot({ path: testInfo.outputPath("project-expanded.png") });
  await page.getByRole("button", { name: "模型与推理强度" }).tap();
  await expect(page.getByRole("slider")).toHaveAttribute("aria-valuetext", "GPT-6 Astra · 中");
  await page.getByRole("button", { name: /2× speed/ }).tap();
  await expect(page.getByRole("button", { name: /2× speed/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("tooltip")).toContainText("2× speed");
  const outline = await page.locator(".remote-speed-icon path").getAttribute("d");
  await expect(page.locator(".remote-speed-particle-path")).toHaveCount(14);
  const moving = page.locator(".remote-speed-particle-path").first();
  const positions = await moving.evaluate(async (element) => {
    const first = getComputedStyle(element).transform;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return [first, getComputedStyle(element).transform];
  });
  expect(positions[0]).not.toBe(positions[1]);
  const tapPreset = async (index: number) => {
    const slider = page.getByRole("slider");
    const bounds = (await slider.boundingBox())!;
    await slider.tap({
      position: { x: 16 + ((bounds.width - 32) * index) / 5, y: bounds.height / 2 },
    });
  };
  for (const [index, label] of [
    [0, "GPT-5.6 Terra · 轻度"],
    [1, "GPT-5.6 Sol · 轻度"],
    [2, "GPT-5.6 Sol · 中"],
    [3, "GPT-6 Astra · 轻度"],
    [4, "GPT-6 Astra · 中"],
    [5, "GPT-6 Astra · 极高"],
  ] as const) {
    await tapPreset(index);
    await expect(page.getByRole("slider")).toHaveAttribute("aria-valuetext", label);
    const options = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("remote-options:new")!),
    );
    expect(options.selectionMode).toBe("default");
    await expect(
      page.getByRole("button", { name: index < 3 ? /1.5× speed/ : /2× speed/ }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await tapPreset(4);
  await page.getByRole("button", { name: /2× speed/ }).tap();
  await expect(page.locator(".remote-speed-particle-path")).toHaveCount(0);
  expect(await page.locator(".remote-speed-icon path").getAttribute("d")).not.toBe(outline);
  await page.getByRole("button", { name: /2× speed/ }).tap();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(moving).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "选择模型", exact: true }).tap();
  await expect(page.getByRole("button", { name: /Default/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".remote-picker-views")).toHaveCSS("transition-duration", "0.32s");
  await expect(page.locator(".remote-picker-list-panel")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("default-model-list.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "GPT-6 Astra", exact: true }).tap();
  await expect(page.getByRole("slider")).toHaveAttribute("aria-valuetext", "高");
  await page.getByRole("button", { name: /2× speed/ }).tap();
  await page.getByRole("button", { name: "Reset to default", exact: true }).tap();
  await expect(page.getByRole("slider")).toHaveAttribute("aria-valuetext", "GPT-6 Astra · 中");
  await expect(page.getByRole("button", { name: /2× speed/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(newInput).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("astra-default-speed.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭输入设置" }).tap({ position: { x: 350, y: 350 } });
  await page.getByRole("button", { name: "创建", exact: true }).tap();
  await page.getByLabel("发送给 Codex").fill("Use the selected default");
  let sent: unknown;
  await page.route("**/api/v1/remote/threads/*/actions", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      json: { error: { code: "INVALID_REQUEST", message: "Captured", requestId: "capture" } },
    });
  });
  await page.getByRole("button", { name: "发送消息", exact: true }).tap();
  await expect(page.getByRole("alert")).toContainText("服务暂时无法连接，请稍后重试。");
  expect(sent).toMatchObject({
    type: "send",
    model: "gpt-6-astra",
    effort: "medium",
    serviceTier: "priority",
    approvalMode: "auto",
  });
});

for (const keyboard of [false, true]) {
  test(`composer tools survive focus loss during mirrored pointer input, keyboard=${keyboard}`, async ({
    page,
  }) => {
    await page.goto("/?remote=1");
    await page.getByRole("button", { name: "新建 Codex 任务" }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const input = page.getByLabel("发送给 Codex");
    await input.focus();
    if (keyboard) {
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, "height", {
          configurable: true,
          get: () => 430,
        });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
    }
    for (const name of ["审批方式", "模型与推理强度"]) {
      await input.focus();
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      // The host can blur before the webpage receives ANY pointer event.
      await input.evaluate((el) => el.blur());
      await page.waitForTimeout(350);
      await expect(button).toBeVisible();
      await button.dispatchEvent("pointerdown", {
        pointerId: 1,
        pointerType: "touch",
        bubbles: true,
      });
      await button.dispatchEvent("pointerup", {
        pointerId: 1,
        pointerType: "touch",
        bubbles: true,
      });
      await page.waitForTimeout(350);
      await expect(button).toBeVisible();
      await button.dispatchEvent("click", { bubbles: true });
      await expect(
        page.getByRole("dialog", { name: name === "审批方式" ? name : "模型设置" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "关闭输入设置" })
        .click({ position: { x: 380, y: 10 } });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });
}

test("keyboard model list scrolls within the popover and keeps the last model selectable", async ({
  page,
}, testInfo) => {
  await page.route("**/api/v1/remote/models", (route) =>
    route.fulfill({
      json: {
        data: Array.from({ length: 9 }, (_, i) => ({
          id: `model-${i}`,
          name: `Model ${i}`,
          efforts: ["low", "medium"],
          defaultEffort: "medium",
        })),
      },
    }),
  );
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("发送给 Codex").focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => 430 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.getByRole("button", { name: "模型与推理强度" }).click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "模型设置" });
  const list = page.locator(".remote-model-list");
  await expect
    .poll(async () => {
      const p = (await popup.boundingBox())!;
      const l = (await list.boundingBox())!;
      return p.y >= 0 && l.y >= p.y && l.y + l.height <= p.y + p.height;
    })
    .toBe(true);
  await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const last = page.getByRole("button", { name: "Model 8", exact: true });
  await expect(last).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("keyboard-models-contained.png") });
  await last.tap();
  await expect(page.getByRole("button", { name: "选择模型", exact: true })).toContainText(
    "Model 8",
  );
});

test("pastes clipboard images as attachments, keeps the draft and allows upload retry", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await input.fill("保留文字");
  let fail = true;
  let uploads = 0;
  await page.route("**/api/v1/remote/uploads", async (route) => {
    uploads++;
    const body = route.request().postDataJSON();
    expect(body.mimeType).toBe("image/png");
    expect(body.name).toBe("clipboard.png");
    if (fail)
      return route.fulfill({
        status: 503,
        json: {
          error: { code: "INVALID_REQUEST", message: "模拟图片上传失败", requestId: "paste" },
        },
      });
    return route.continue();
  });
  const paste = () =>
    input.evaluate((element) => {
      const data = new DataTransfer();
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      data.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
  await paste();
  await expect(page.getByRole("alert")).toContainText("服务暂时无法连接");
  await expect(input).toHaveValue("保留文字");
  fail = false;
  await paste();
  await expect(page.getByRole("button", { name: "移除 clipboard.png" })).toBeVisible();
  await expect(input).toHaveValue("保留文字");
  expect(uploads).toBe(2);
  const thumbnail = page.getByRole("button", { name: "查看图片 clipboard.png" });
  await expect(thumbnail.locator("img")).toBeVisible();
  await expect
    .poll(() => thumbnail.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await thumbnail.click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await expect(page.locator(".remote-image-surface")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect
    .poll(async () => (await page.getByRole("dialog", { name: "图片预览" }).boundingBox())!.y)
    .toBe(0);
  await page.screenshot({ path: "/tmp/remote-image-preview-" + test.info().project.name + ".png" });
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(input).toHaveValue("保留文字");

  const textWasNotCanceled = await input.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "普通文本");
    return element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  expect(textWasNotCanceled).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "移除 clipboard.png" })).toBeVisible();
  await expect
    .poll(() => thumbnail.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});

test("running model picker hides the settings note while choosing a model", async ({
  page,
}, testInfo) => {
  const id = "11111111-1111-4111-8111-111111111120";
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id,
          title: "运行中选择模型",
          cwd: "/project",
          model: "model-0",
          effort: "medium",
          status: "active",
          activeTurnId: "running",
          historyComplete: true,
          requests: [],
          turns: [{ id: "running", status: "inProgress", diff: "", error: "", items: [] }],
        },
      },
    }),
  );
  await page.route("**/api/v1/remote/models", (route) =>
    route.fulfill({
      json: {
        data: Array.from({ length: 9 }, (_, i) => ({
          id: `model-${i}`,
          name: `Model ${i}`,
          efforts: ["low", "medium"],
          defaultEffort: "medium",
        })),
      },
    }),
  );
  await page.goto(`/?remote=1&remoteThread=${id}`);
  await page.getByLabel("发送给 Codex").fill("跟进");
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => 430 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.getByRole("button", { name: "模型与推理强度" }).click();
  const note = page.locator(".remote-picker-simple-panel > .remote-settings-note");
  await expect(note).toHaveText("当前回合与排队消息保持原设置；用于空闲后的发送");
  await expect(note).toHaveCSS("opacity", "1");
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await expect(note).toHaveCSS("opacity", "0");
    const list = page.locator(".remote-model-list");
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByRole("button", { name: "Model 8", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`running-models-${reducedMotion}.png`) });
    await page.getByRole("button", { name: "Model 8", exact: true }).click();
    await expect(note).toHaveCSS("opacity", "1");
  }
  await expect(page.getByLabel("发送给 Codex")).toHaveValue("跟进");
});

test("image preview has a clear close button and supports canceling and completing a downward swipe", async ({
  page,
}, testInfo) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await input.fill("预览后继续编辑");
  await page.getByLabel("上传文件").setInputFiles({
    name: "white.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const thumb = page.getByRole("button", { name: "查看图片 white.png" });
  const dialog = page.getByRole("dialog", { name: "图片预览" });
  const close = page.getByRole("button", { name: "关闭图片预览" });
  for (let i = 0; i < 3; i++) {
    await thumb.click();
    await expect(close).toHaveText("");
    await expect(dialog.getByText("向下滑动关闭")).toHaveCount(0);
    expect((await close.boundingBox())!.x).toBeLessThan(60);
    await expect(close).toBeInViewport();
    await close.focus();
    await expect(close).toHaveCSS("outline-style", "none");
    await expect(close).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await close.click();
    await expect(close).not.toBeVisible({ timeout: 120 });
    await expect(dialog).toHaveCount(0);
    await input.fill(`预览后继续编辑 ${i}`);
  }
  await thumb.click();
  const surface = page.locator(".remote-image-surface");
  await expect(surface).toHaveCSS("touch-action", "none");
  const bounds = (await surface.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 35, { steps: 6 });
  await page.mouse.up();
  await expect(dialog).toHaveCount(1);
  await expect(surface.locator("img")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await page.screenshot({ path: `/tmp/remote-image-close-${testInfo.project.name}.png` });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 180, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
  for (const dx of [-170, 170]) {
    await thumb.click();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + 110, { steps: 10 });
    const transform = await surface
      .locator("img")
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
    expect(Math.abs(transform)).toBeGreaterThan(150);
    await page.mouse.up();
    await expect(dialog).toHaveCount(0);
  }
  await input.fill("下拉关闭后仍可编辑");
  await thumb.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue("下拉关闭后仍可编辑");
});

test("draft text and attachments survive closing and reopening the page", async ({
  page,
  context,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("发送给 Codex").fill("退出应用也要保留的草稿");
  await page.getByLabel("上传文件").setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft attachment"),
  });
  await expect(page.getByRole("button", { name: "移除 draft.txt" })).toBeVisible();
  const url = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url);
  await expect(reopened.getByLabel("发送给 Codex")).toHaveValue("退出应用也要保留的草稿");
  await expect(reopened.getByRole("button", { name: "移除 draft.txt" })).toBeVisible();
  await reopened.getByLabel("发送给 Codex").fill("");
  await reopened.getByRole("button", { name: "移除 draft.txt" }).click();
  await reopened.close();
  const cleared = await context.newPage();
  await cleared.goto(url);
  await expect(cleared.getByLabel("发送给 Codex")).toHaveValue("");
  await expect(cleared.getByRole("button", { name: "移除 draft.txt" })).toHaveCount(0);
});

test("video uploads use small binary chunks and recover a dropped segment", async ({ page }) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("发送给 Codex").fill("检查视频");
  let dropped = false;
  const segments: number[] = [];
  await page.route("**/api/v1/remote/uploads/chunks?**", async (route) => {
    const index = Number(new URL(route.request().url()).searchParams.get("index"));
    segments.push(index);
    expect(route.request().headers()["content-type"]).toBe("application/octet-stream");
    // WebKit does not expose Blob request bodies through its inspection protocol.
    const body = route.request().postDataBuffer();
    if (body) expect(body.length).toBeLessThanOrEqual(192 * 1024);
    if (index === 1 && !dropped) {
      dropped = true;
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page
    .getByLabel("上传文件")
    .setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1_258_291, 7) });
  await expect(page.getByRole("button", { name: "移除 clip.mp4" })).toBeVisible({ timeout: 20000 });
  expect(dropped).toBe(true);
  expect(segments.filter((index) => index === 1)).toHaveLength(2);
  expect(new Set(segments).size).toBe(7);
});

test("upload network errors are explained in Chinese and can be dismissed", async ({ page }) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("发送给 Codex").fill("保留草稿");
  await page.route("**/api/v1/remote/uploads", (route) => route.abort("connectionreset"));
  await page
    .getByLabel("上传文件")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("网络");
  await alert.getByRole("button", { name: "关闭提示" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByLabel("发送给 Codex")).toHaveValue("保留草稿");
});

test("keyboard resize keeps the latest message visible without waiting for polling", async ({
  page,
}) => {
  const id = "11111111-1111-4111-8111-111111111121";
  await page.route(`**/api/v1/remote/threads/${id}`, (route) =>
    route.fulfill({
      json: {
        data: {
          id,
          title: "滚动检查",
          cwd: "/project",
          model: "test",
          effort: "medium",
          status: "idle",
          activeTurnId: null,
          historyComplete: true,
          requests: [],
          turns: [
            {
              id: "done",
              status: "completed",
              diff: "",
              error: "",
              items: [
                {
                  id: "text",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "旧内容\n\n".repeat(60) + "最新消息在这里",
                  detail: "",
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await page.goto(`/?remote=1&remoteThread=${id}`);
  const messages = page.locator(".remote-messages");
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(5);
  await page.getByLabel("发送给 Codex").focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => 430 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 700,
    })
    .toBeLessThan(5);
  await messages.evaluate(async (el) => {
    el.scrollTop = 0;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => 500 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBe(0);
});

for (const richContent of [
  {
    name: "code blocks",
    selector: "pre code",
    markdown: "```text\n" + "输出内容\n".repeat(45) + "```",
  },
  {
    name: "diagrams",
    selector: ".mermaid-diagram svg",
    markdown: "```mermaid\ngraph TD\n A-->B\n B-->C\n C-->D\n D-->E\n E-->F\n```",
  },
]) {
  test(`polling preserves ${richContent.name} and the bottom position`, async ({ page }) => {
    const id = "11111111-1111-4111-8111-111111111122";
    let polls = 0;
    const text = "历史消息\n\n".repeat(30) + richContent.markdown + "\n\n最后一条消息";
    await page.route(`**/api/v1/remote/threads/${id}`, (route) => {
      polls++;
      return route.fulfill({
        json: {
          data: {
            id,
            title: `底部滚动检查 ${polls}`,
            cwd: "/project",
            model: "test",
            effort: "medium",
            status: "idle",
            activeTurnId: null,
            historyComplete: true,
            requests: [],
            turns: [
              {
                id: "done",
                status: "completed",
                diff: "",
                error: "",
                items: [
                  { id: "text", type: "agentMessage", phase: "final_answer", text, detail: "" },
                ],
              },
            ],
          },
        },
      });
    });
    await page.goto(`/?remote=1&remoteThread=${id}`);
    const messages = page.locator(".remote-messages");
    await expect
      .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(5);
    await expect(messages.getByText("最后一条消息", { exact: true })).toBeVisible();
    await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(5);
    const rendered = messages.locator(richContent.selector);
    await expect(rendered).toBeVisible();
    await messages.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await rendered.evaluate((el) => Reflect.set(el, "remotePreserved", true));
    const initialPolls = polls;
    await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThanOrEqual(initialPolls + 2);
    await expect
      .poll(() => rendered.evaluate((el) => Reflect.get(el, "remotePreserved")))
      .toBe(true);
    await expect
      .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(5);
  });
}

test("unchanged polling leaves native bottom scrolling alone", async ({ page }) => {
  // Keep the fixture independent of uncommitted changes in the test checkout:
  // a late review shortcut legitimately resizes the message area by 42px.
  await page.route("**/api/v1/remote/threads/*/review?*", (route) =>
    route.fulfill({
      json: {
        data: {
          repository: false,
          branch: null,
          baseRef: null,
          scope: "branch",
          changedCount: 0,
          added: 0,
          removed: 0,
          countsComplete: true,
          files: [],
          message: "",
        },
      },
    }),
  );
  const id = "11111111-1111-4111-8111-111111111122";
  let polls = 0;
  let text = "历史消息\n\n".repeat(60) + "最后一条消息";
  await page.route(`**/api/v1/remote/threads/${id}`, (route) => {
    polls++;
    return route.fulfill({
      json: {
        data: {
          id,
          title: "底部滚动检查",
          cwd: "/project",
          model: "test",
          effort: "medium",
          status: "idle",
          activeTurnId: null,
          historyComplete: true,
          requests: [],
          turns: [
            {
              id: "done",
              status: "completed",
              diff: "",
              error: "",
              items: [
                { id: "text", type: "agentMessage", phase: "final_answer", text, detail: "" },
              ],
            },
          ],
        },
      },
    });
  });
  await page.goto(`/?remote=1&remoteThread=${id}`);
  const messages = page.locator(".remote-messages");
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(5);
  await expect(messages.getByText("最后一条消息", { exact: true })).toBeVisible();
  await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(5);
  // Repeated writes interrupt WebKit's native momentum/rubber-band scrolling even
  // when the assigned offset clamps to the same bottom position.
  await messages.evaluate((el) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    el.setAttribute("data-scroll-writes", "0");
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value) {
        this.setAttribute(
          "data-scroll-writes",
          String(Number(this.getAttribute("data-scroll-writes")) + 1),
        );
        descriptor.set!.call(this, value);
      },
    });
  });
  const initialPolls = polls;
  await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThanOrEqual(initialPolls + 2);
  await expect(messages).toHaveAttribute("data-scroll-writes", "0");
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(5);
  text += "\n\n新回复".repeat(20);
  await expect(messages.getByText("新回复", { exact: true }).last()).toBeAttached();
  await expect
    .poll(() => messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(5);
  await messages.evaluate((el) => {
    el.scrollTop = 200;
  });
  await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBe(200);
  text += "\n\n继续回复".repeat(20);
  await expect(messages.getByText("继续回复", { exact: true }).last()).toBeAttached();
  await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBe(200);
});

test("running conversations can queue attachments without waiting for the current turn", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await input.fill("权限与引导验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page
    .getByRole("region", { name: "权限审批" })
    .getByRole("button", { name: "允许一次" })
    .click();
  await expect(page.getByRole("region", { name: "权限审批" })).toHaveCount(0);
  await input.fill("请查看截图");
  await page.getByLabel("上传文件").setInputFiles({
    name: "screen.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByRole("button", { name: "移除 screen.png" })).toBeVisible();
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole("article", { name: "排队消息" })).toContainText("请查看截图");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "移除 screen.png" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止 Codex" })).toBeVisible();
  const queued = page.getByRole("article", { name: "排队消息" });
  await expect(queued).toContainText("screen.png");
  await queued.getByRole("button").click();
  const menu = page.getByRole("dialog", { name: "排队消息操作" });
  await menu.getByRole("button", { name: "编辑消息" }).click();
  await expect(input).toHaveValue("请查看截图");
  await expect(page.getByRole("button", { name: "移除 screen.png" })).toBeVisible();
  await input.fill("修改后的截图说明");
  await send.click();
  await expect(queued).toContainText("修改后的截图说明");
  await page.reload();
  await expect(queued).toContainText("screen.png");
  let rejectSteer = true;
  await page.route("**/api/v1/remote/threads/*/actions", (route) => {
    if (rejectSteer && route.request().postDataJSON().operation === "steer") {
      rejectSteer = false;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INVALID_REQUEST", message: "测试：引导失败" } }),
      });
    }
    return route.continue();
  });
  await queued.getByRole("button").click();
  await menu.getByRole("button", { name: "改为引导" }).click();
  await expect(input).toHaveValue("修改后的截图说明");
  await expect(page.getByRole("button", { name: "移除 screen.png" })).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue("修改后的截图说明");
  await page.getByRole("button", { name: "移除 screen.png" }).click();
  await input.fill("");
  await queued.getByRole("button").click();
  await menu.getByRole("button", { name: "改为引导" }).click();
  await expect(queued).toHaveCount(0);
  await expect(
    page.locator(".remote-user-message").filter({ hasText: "修改后的截图说明" }),
  ).toBeVisible();
});

test("connection failures show a Chinese refresh action without a dismiss cross", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const input = page.getByLabel("发送给 Codex");
  await input.fill("断线后保留草稿");
  let unavailable = true;
  await page.route("**/api/v1/remote/threads/*", (route) =>
    unavailable && route.request().method() === "GET"
      ? route.abort("connectionreset")
      : route.continue(),
  );
  const alert = page.getByRole("alert").filter({ hasText: "网络连接中断" });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "关闭提示" })).toHaveCount(0);
  await expect(alert.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
  unavailable = false;
  await alert.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(input).toHaveValue("断线后保留草稿");
});

test("a sent message appears before live activity without reopening and stays unique after hydration", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveURL(/remoteThread=/);
  const url = page.url();
  await page.getByLabel("发送给 Codex").fill("实时消息显示验收");
  const snapshot = page.waitForResponse(async (response) => {
    if (!/\/remote\/threads\/[^/]+$/.test(new URL(response.url()).pathname) || !response.ok())
      return false;
    const body = await response.json();
    return body.data?.turns?.some((turn: { items: { id: string }[] }) =>
      turn.items.some((item) => item.id.startsWith("remote-input:")),
    );
  });
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await snapshot;
  const message = page.locator(".remote-user-message").filter({ hasText: "实时消息显示验收" });
  await expect(message).toHaveCount(1);
  await expect(page.getByText("正在处理本次请求")).toBeVisible();
  expect(page.url()).toBe(url);
  await page.waitForResponse(async (response) => {
    if (!/\/remote\/threads\/[^/]+$/.test(new URL(response.url()).pathname) || !response.ok())
      return false;
    const body = await response.json();
    return body.data?.turns?.some((turn: { items: { id: string }[] }) =>
      turn.items.some((item) => item.id.startsWith("user-")),
    );
  });
  await expect(message).toHaveCount(1);
  expect(page.url()).toBe(url);
});

test("cancel upload stops pending chunks, preserves draft and allows another upload", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  const input = page.getByLabel("新任务消息");
  await input.fill("取消后保留草稿");
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (resource, init) =>
      String(resource).includes("/uploads/chunks?")
        ? new Promise((_resolve, reject) =>
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
              once: true,
            }),
          )
        : original(resource, init);
  });
  await page.getByLabel("上传文件").setInputFiles({
    name: "cancel.mov",
    mimeType: "video/quicktime",
    buffer: Buffer.alloc(192 * 1024 * 8),
  });
  const cancel = page.getByRole("button", { name: "取消上传" });
  await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const labelBox = await page.locator(".remote-upload-progress > span").boundingBox();
  const cancelBox = await cancel.boundingBox();
  expect(cancelBox!.x - labelBox!.x - labelBox!.width).toBeCloseTo(4, 0);
  const fontSize = await cancel.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(cancelBox!.width).toBeCloseTo(fontSize, 0);
  expect(cancelBox!.height).toBeCloseTo(fontSize, 0);
  await cancel.click();
  await expect(page.getByText(/正在上传/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(input).toHaveValue("取消后保留草稿");
  await expect(page.getByRole("button", { name: "移除 cancel.mov" })).toHaveCount(0);
  await page
    .getByLabel("上传文件")
    .setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry") });
  await expect(page.getByRole("button", { name: "移除 retry.txt" })).toBeVisible();
});

test("Feishu native album includes recordings and stays quiet until selection completes", async ({
  page,
}) => {
  const size = 13 * 1024 * 1024;
  await page.addInitScript(
    ({ size }) => {
      Object.defineProperty(navigator, "userAgent", {
        value: navigator.userAgent + " Lark/7.50.0",
      });
      Object.assign(window, {
        h5sdk: {
          ready: (ready: () => void) => ready(),
          config: (options: { onSuccess(): void; jsApiList: string[] }) => {
            document.documentElement.dataset.feishuApis = options.jsApiList.join(",");
            options.onSuccess();
          },
        },
        tt: {
          chooseMedia: (options: {
            sourceType: string[];
            mediaType: string[];
            count: number;
            success(result: unknown): void;
            fail(error: unknown): void;
          }) => {
            document.documentElement.dataset.albumOpened = String(
              Number(document.documentElement.dataset.albumOpened || 0) + 1,
            );
            document.documentElement.dataset.albumSource = options.sourceType.join(",");
            document.documentElement.dataset.albumTypes = options.mediaType.join(",");
            const cancel = () => {
              clean();
              options.fail({ errMsg: "chooseMedia:fail cancel" });
            };
            const choose = () => {
              clean();
              options.success({
                tempFiles: [
                  { tempFilePath: "ttfile://temp/ScreenRecording.MOV", type: "video", size },
                ],
              });
            };
            const clean = () => {
              document.removeEventListener("test:albumCancel", cancel);
              document.removeEventListener("test:albumChoose", choose);
            };
            document.addEventListener("test:albumCancel", cancel);
            document.addEventListener("test:albumChoose", choose);
          },
          getFileSystemManager: () => ({
            readFile: (options: {
              position: number;
              length: number;
              success(result: { data: string }): void;
              fail(error: unknown): void;
            }) => {
              if (!options.length || options.length > 10 * 1024 * 1024) {
                options.fail({ errMsg: "readFile:fail exceed max read size" });
                return;
              }
              options.success({
                data: btoa("v".repeat(Math.min(options.length, size - options.position))),
              });
            },
          }),
        },
      });
    },
    { size },
  );
  let browserPickers = 0;
  page.on("filechooser", () => browserPickers++);
  let uploads = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/remote/uploads**", async (route) => {
    uploads++;
    await ready;
    await route.continue();
  });
  await page.route("**/api/v1/auth/feishu/jsapi-config?**", (route) =>
    route.fulfill({
      json: {
        data: {
          appId: "cli_fixture",
          timestamp: Date.now(),
          nonceStr: "nonce",
          signature: "a".repeat(40),
          jsApiList: ["chooseMedia", "readFile"],
        },
      },
    }),
  );
  await page.goto("/?remote=1");
  await page.getByRole("button", { name: "新建 Codex 任务" }).click();
  const input = page.getByLabel("新任务消息");
  await input.fill("保留录屏说明");
  await page.evaluate(() => {
    document.documentElement.dataset.uploadNotices = "0";
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches(".remote-upload-progress") ||
              node.querySelector(".remote-upload-progress"))
          ) {
            document.documentElement.dataset.uploadNotices = String(
              Number(document.documentElement.dataset.uploadNotices) + 1,
            );
          }
        }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const openAlbum = async () => {
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    await page.getByRole("button", { name: "照片与视频", exact: true }).click();
  };
  await openAlbum();
  await expect(page.locator("html")).toHaveAttribute("data-album-opened", "1");
  await expect(page.locator("html")).toHaveAttribute("data-album-source", "album");
  await expect(page.locator("html")).toHaveAttribute("data-album-types", "image,video");
  await expect(page.locator("html")).toHaveAttribute("data-feishu-apis", "chooseMedia,readFile");
  await expect(page.locator("html")).toHaveAttribute("data-upload-notices", "0");
  await page.evaluate(() => document.dispatchEvent(new Event("test:albumCancel")));
  await expect(input).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("data-upload-notices", "0");
  expect(uploads).toBe(0);
  expect(browserPickers).toBe(0);
  await expect(input).toHaveValue("保留录屏说明");
  await openAlbum();
  await expect(page.locator("html")).toHaveAttribute("data-album-opened", "2");
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("test:albumChoose")));
    await expect(page.getByText("正在上传 0%", { exact: true })).toBeVisible();
    await expect.poll(() => uploads).toBeGreaterThan(0);
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "移除 ScreenRecording.MOV" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "取消上传" })).toHaveCount(0);
  await expect(input).toHaveValue("保留录屏说明");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(browserPickers).toBe(0);
});
