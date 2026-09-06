import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveSingleByteRange } from "../utils/http-byte-range";

test("backup byte ranges support initial, open-ended, and suffix requests", () => {
  assert.deepEqual(resolveSingleByteRange(undefined, 1000), { kind: "full" });
  assert.deepEqual(resolveSingleByteRange("bytes=0-99", 1000), {
    kind: "partial", start: 0, end: 99, length: 100
  });
  assert.deepEqual(resolveSingleByteRange("bytes=900-", 1000), {
    kind: "partial", start: 900, end: 999, length: 100
  });
  assert.deepEqual(resolveSingleByteRange("bytes=-64", 1000), {
    kind: "partial", start: 936, end: 999, length: 64
  });
  assert.deepEqual(resolveSingleByteRange("bytes=900-1200", 1000), {
    kind: "partial", start: 900, end: 999, length: 100
  });
});

test("backup byte ranges reject invalid or unsupported requests", () => {
  for (const value of ["items=0-10", "bytes=", "bytes=1000-", "bytes=20-10", "bytes=0-1,4-5", "bytes=-0"]) {
    assert.deepEqual(resolveSingleByteRange(value, 1000), { kind: "unsatisfiable" });
  }
});

test("backup downloads use native streaming instead of buffering a Blob", () => {
  const download = readFileSync(join(process.cwd(), "packages/ui/src/utils/download.ts"), "utf8");
  const page = readFileSync(join(process.cwd(), "packages/ui/src/pages/settings/DataAuditSettingsPage.vue"), "utf8");
  const route = readFileSync(join(process.cwd(), "packages/server/routes/api/backups/[id]/download.get.ts"), "utf8");
  const headRoute = readFileSync(join(process.cwd(), "packages/server/routes/api/backups/[id]/download.head.ts"), "utf8");
  const streamedFunction = download.match(/export async function downloadStreamedFile[\s\S]*?\n\}/)?.[0] || "";
  assert.match(streamedFunction, /method:\s*"HEAD"/);
  assert.match(streamedFunction, /triggerAnchorDownload\(url, filename\)/);
  assert.match(download, /function triggerAnchorDownload[\s\S]*?anchor\.click\(\)/);
  assert.doesNotMatch(streamedFunction, /\.blob\(\)/);
  assert.match(page, /downloadStreamedFile\(`backups\/\$\{encodeURIComponent\(backup\.id\)\}\/download`/);
  assert.match(route, /"accept-ranges",\s*"bytes"/);
  assert.match(route, /createReadStream\(backup\.path, \{ start: range\.start, end: range\.end \}\)/);
  assert.match(route, /setResponseStatus\(event, 416, "Range Not Satisfiable"\)/);
  assert.match(headRoute, /"content-length",\s*String\(backup\.sizeBytes\)/);
  assert.match(headRoute, /"accept-ranges",\s*"bytes"/);
});

test("downloads avoid attachment navigation in embedded WebViews", () => {
  const download = readFileSync(join(process.cwd(), "packages/ui/src/utils/download.ts"), "utf8");
  const reportDetail = readFileSync(join(process.cwd(), "packages/ui/src/components/ReportDetail.vue"), "utf8");
  const imageViewer = readFileSync(join(process.cwd(), "packages/ui/src/components/ImageViewer.vue"), "utf8");
  /* 内嵌 WebView/iOS 统一走系统分享菜单，失败退回复制链接，不再把 WebView 导航到附件地址（会触发 WebKitErrorDomain 102） */
  assert.match(download, /function useWebSharePath\(\)/);
  assert.match(download, /navigator\.share\(\{ files: \[file\]/);
  assert.match(download, /copyTextToClipboard/);
  const streamedFunction = download.match(/export async function downloadStreamedFile[\s\S]*?\n\}/)?.[0] || "";
  const directFunction = download.match(/export async function downloadDirectUrl[\s\S]*?\n\}/)?.[0] || "";
  const fileFunction = download.match(/export async function downloadFile[\s\S]*?\n\}/)?.[0] || "";
  assert.match(streamedFunction, /useWebSharePath\(\)/);
  assert.match(directFunction, /useWebSharePath\(\)/);
  assert.match(fileFunction, /useWebSharePath\(\)/);
  /* 报告详情和图片/PDF 查看器不得保留裸 <a download> 下载链接 */
  assert.doesNotMatch(reportDetail, /<a :href="originalUrl/);
  assert.doesNotMatch(imageViewer, /<a :href="viewerDownloadSrc"/);
  assert.match(reportDetail, /downloadDirectUrl/);
  assert.match(imageViewer, /downloadDirectUrl/);
});
