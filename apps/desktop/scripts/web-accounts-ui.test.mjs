import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium, webkit } from "playwright";
const ui = new URL("../ui/", import.meta.url);
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: local account UI creates, disables and resets without retaining passwords`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 730 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(
        readFileSync(new URL("index.html", ui), "utf8").replace(/<script[^>]*><\/script>/g, ""),
      );
      await page.addStyleTag({ content: readFileSync(new URL("style.css", ui), "utf8") });
      await page.evaluate(() => {
        window.calls = [];
        window.__TAURI__ = {
          core: {
            invoke: async (name, args) => {
              if (name === "snapshot")
                return {
                  phase: "ready",
                  services: [],
                  logs: [],
                  webAccountsRevision: 1,
                  webAccounts: [
                    {
                      id: "00000000-0000-4000-8000-000000000005",
                      username: "alice",
                      name: "Alice",
                      active: 1,
                    },
                  ],
                };
              window.calls.push({ name, args });
            },
          },
        };
      });
      await page.addScriptTag({ content: readFileSync(new URL("app.js", ui), "utf8") });
      await page.locator('[data-tab="connections"]').click();
      assert.equal(await page.locator('[data-tab="ports"]').count(), 0);
      assert.equal(await page.locator("#port-api").isVisible(), false);
      await page.locator("#ports > summary").click();
      await page.locator("#port-api").fill("60001");
      await page.locator("#ports > summary").click();
      assert.equal(await page.locator("#port-api").isVisible(), false);
      await page.locator("#ports > summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("#port-api").inputValue(), "60001");
      assert.equal(await page.locator("#port-api").isVisible(), true);
      await page.locator('[data-tab="settings"]').click();
      assert.equal(await page.locator("#web-username").isVisible(), false);
      assert.equal(await page.locator("#skill-status").isVisible(), false);
      await page.locator('[data-tab="connections"]').click();
      await page.locator("#connections-card > summary").click();
      await page.locator("#connections-web-accounts").click();
      assert.equal(await page.locator("#web-username").isVisible(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), "web-username");
      await page.locator("#web-accounts-card > summary").click();
      assert.equal(await page.locator("#web-username").isVisible(), false);
      await page.locator("#web-accounts-card > summary").click();
      await page.locator("#web-username").fill("bob");
      await page.locator("#web-name").fill("Bob");
      await page.locator("#web-password").fill("a-long-test-password");
      await page.locator("#web-account-create").click();
      assert.equal(await page.locator("#web-password").inputValue(), "");
      await page.getByRole("button", { name: "停用并退出登录" }).click();
      await page.getByRole("button", { name: "重置密码", exact: true }).click();
      await page.locator("#web-reset-password").fill("another-test-password");
      await page.getByRole("button", { name: "保存新密码" }).click();
      assert.equal(await page.locator("#web-reset-password").inputValue(), "");
      const calls = await page.evaluate(() => window.calls);
      assert.deepEqual(
        calls.map((c) => c.args.settings.operation),
        ["list", "create", "update", "update"],
      );
      assert.equal(calls[2].args.settings.active, false);
      assert.equal(calls[3].args.settings.password, "another-test-password");
      assert.deepEqual(errors, []);
      if (process.env.WEB_ACCESS_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.WEB_ACCESS_SCREENSHOTS}/${name}-web-accounts.png`,
          fullPage: true,
        });
    } finally {
      await browser.close();
    }
  });
}
