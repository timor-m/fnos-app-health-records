import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function readSource(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("me-section secondary pages share the same account topbar as the me page", () => {
  const source = readSource("packages/ui/src/layouts/AppShell.vue");
  // “我的”及其二级页统一展示账号信息顶栏（头像/名称/账号角色/提醒铃铛）
  assert.match(source, /route\.path === "\/me" \|\| route\.path\.startsWith\("\/me\/"\)/);
});

test("back-to-top rocket only appears beyond 2x viewport height and scrolls smoothly", () => {
  const source = readSource("packages/ui/src/components/BackToTop.vue");
  assert.match(source, /window\.scrollY > window\.innerHeight \* 2/);
  assert.match(source, /window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\)/);
  assert.match(source, /Rocket/);
  assert.match(source, /class="back-to-top"/);
  // KeepAlive 缓存页需要成对维护滚动监听
  assert.match(source, /onDeactivated/);
  assert.match(source, /onActivated/);
});

test("back-to-top is mounted on records, trends and log list pages", () => {
  for (const path of [
    "packages/ui/src/pages/RecordsPage.vue",
    "packages/ui/src/pages/TrendsPage.vue",
    "packages/ui/src/pages/settings/SystemLogsSettingsPage.vue",
    "packages/ui/src/pages/settings/UserAuditSettingsPage.vue",
  ]) {
    const source = readSource(path);
    assert.match(source, /import BackToTop from/, path);
    assert.match(source, /<BackToTop \/>/, path);
  }
});

test("back-to-top styles keep the button above the mobile bottom nav", () => {
  const styles = readSource("packages/ui/src/styles.css");
  assert.match(styles, /\.back-to-top \{/);
  assert.match(styles, /\.back-to-top \{ right: 14px; bottom: calc\(66px \+ var\(--safe-bottom\) \+ 28px\); \}/);
});
