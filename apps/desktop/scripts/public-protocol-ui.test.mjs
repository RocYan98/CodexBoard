import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";
const ui = new URL("../ui/", import.meta.url);
for (const [name, engine] of Object.entries({ chromium, webkit }))
  test(`${name}: only frpc config is submitted; no manual public connection controls`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 730 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setContent(
        readFileSync(new URL("index.html", ui), "utf8").replace(
          /<script[^>]*src="app.js"[^>]*><\/script>/,
          "",
        ),
      );
      await page.addStyleTag({ content: readFileSync(new URL("style.css", ui), "utf8") });
      await page.evaluate(() => {
        window.calls = [];
        window.__TAURI__ = {
          core: {
            invoke: async (name, args) => {
              if (name === "control") {
                window.calls.push(args);
                return;
              }
              return {
                phase: "ready",
                ports: { api: 58978, admin: 58979, bridge: 58980, caddy: 58981 },
                deployment: {
                  appId: "cli_test",
                  appSecret: "test-secret",
                  frpc: 'serverAddr="8.8.8.8"',
                },
                services: [],
                logs: [],
              };
            },
          },
        };
      });
      await page.addScriptTag({ content: readFileSync(new URL("app.js", ui), "utf8") });
      await page.locator('[data-tab="connections"]').click();
      await page.locator("#connections-card > summary").click();
      assert.equal(
        await page
          .locator("#public-domain,#public-port,#certificate-file,#private-key-file,#tcp-protocol")
          .count(),
        0,
      );
      const frpc =
        '[[proxies]]\nname="board"\ntype="https"\nlocalPort=58981\ncustomDomains=["board.example.com"]';
      await page.locator("#frpc-content").fill(frpc);
      await page.locator("#save-connections").click();
      const calls = await page.evaluate(() => window.calls);
      assert.deepEqual(calls, [
        {
          action: "deployment",
          settings: { appId: "cli_test", appSecret: "test-secret", frpc },
        },
      ]);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
