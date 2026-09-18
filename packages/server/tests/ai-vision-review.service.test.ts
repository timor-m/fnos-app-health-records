import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests } from "../database/client.ts";
import { saveAiSettings } from "../services/ai-settings.service.ts";
import {
  normalizeAiExtraction,
  type AiExtractionResult,
  type AiObservation,
} from "../services/ai-extraction.service.ts";
import type { PlannedOcrLine } from "../services/ai-input-planner.service.ts";
import {
  acceptVisionObservations,
  groupVisionReviewPages,
  runVisionReview,
  type AiVisionReviewEvent,
  type VisionReviewCandidateLine,
} from "../services/ai-vision-review.service.ts";
import type {
  AiRuntimeConfig,
  AiRuntimeRequest,
  AiRuntimeResponse,
} from "../services/ai-runtime.service.ts";

function candidateLine(
  pageId: string,
  pageNumber: number,
  index: number,
  text: string,
): VisionReviewCandidateLine {
  return {
    pageId,
    pageNumber,
    line: { id: `${pageId}-line-${index}`, index, text } as PlannedOcrLine,
  };
}

function visionObservation(
  itemName: string,
  resultText: string,
  quote: string,
  pageNumber = 1,
): AiObservation {
  return {
    sectionName: null,
    itemCode: null,
    itemName,
    normalizedName: null,
    resultText,
    numericValue: Number(resultText),
    unit: null,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    abnormalFlag: null,
    method: null,
    evidence: [{ pageNumber, quote }],
  };
}

function emptyResult(observations: AiObservation[] = []): AiExtractionResult {
  return {
    provider: "test",
    model: "test",
    promptVersion: "test",
    ...normalizeAiExtraction({ observations }),
    rawResponseJson: "{}",
    promptTokens: 1,
    completionTokens: 1,
    elapsedMs: 1,
  };
}

test("groupVisionReviewPages groups by page, caps pages and per-page candidates", () => {
  const candidates = [
    ...Array.from({ length: 15 }, (_, index) =>
      candidateLine("page-b", 2, index + 1, `指标B${index} ${index + 1} U/L`),
    ),
    candidateLine("page-a", 1, 1, "指标A 1 U/L"),
    candidateLine("page-c", 3, 1, "指标C1 1 U/L"),
    candidateLine("page-c", 3, 2, "指标C2 2 U/L"),
  ];
  const groups = groupVisionReviewPages(candidates, 2);
  // page-b(15) 与 page-c(2) 候选最多入选，page-a 被页数上限裁掉；输出按页码排序
  assert.deepEqual(groups.map((group) => group.pageId), ["page-b", "page-c"]);
  assert.equal(groups[0].lines.length, 12);
  assert.equal(groups[0].omittedCandidates, 3);
  // 页内候选保持原始行序
  assert.ok(groups[0].lines.every((line, index) => line.index === index + 1));
});

test("acceptVisionObservations anchors quotes to candidate lines and tags vision source", () => {
  const group = groupVisionReviewPages([
    candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L 参考范围 125-350"),
    candidateLine("page-1", 1, 2, "备注：请结合临床"),
  ])[0];
  const { accepted, rejected } = acceptVisionObservations(
    [
      // 模型返回的 q 带了列表序号与空白差异，compact 后仍命中候选行
      visionObservation("血小板计数", "205", "[1] 血小板计数  205 10^9/L 参考范围 125-350"),
      visionObservation("备注", "请结合临床", "备注：请结合临床"),
      // 不命中任何候选行的输出视为幻觉，拒收
      visionObservation("凭空项目", "9", "凭空项目 9 U/L"),
    ],
    group,
    emptyResult(),
  );
  assert.equal(accepted.length, 2);
  assert.equal(rejected, 1);
  assert.deepEqual(accepted[0].evidence, [
    {
      pageNumber: 1,
      quote: "血小板计数 205 10^9/L 参考范围 125-350",
      source: "vision",
    },
  ]);
});

test("acceptVisionObservations rejects same-name duplicates already extracted on the page", () => {
  const group = groupVisionReviewPages([
    candidateLine("page-1", 1, 1, "血红蛋白 130 g/L"),
    candidateLine("page-1", 1, 2, "血小板计数 205 10^9/L"),
  ])[0];
  const existing = emptyResult([
    visionObservation("血红蛋白", "158", "血红蛋白 158 g/L", 1),
    // 同名但证据在其它页，不影响本页补充
    visionObservation("血小板计数", "100", "血小板计数 100 10^9/L", 2),
  ]);
  const { accepted, rejected } = acceptVisionObservations(
    [
      visionObservation("血红蛋白", "130", "血红蛋白 130 g/L"),
      visionObservation("血小板计数", "205", "血小板计数 205 10^9/L"),
    ],
    group,
    existing,
  );
  assert.deepEqual(accepted.map((item) => item.itemName), ["血小板计数"]);
  assert.equal(rejected, 1);
});

async function withAiSettings(
  visionEnabled: boolean,
  run: () => Promise<void>,
) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-vision-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    saveAiSettings({
      enabled: true,
      provider: "deepseek",
      baseUrl: "https://api.example.com/v1",
      textModel: "text-model",
      visionModel: "vision-model",
      visionEnabled,
      apiKey: "test-key",
    });
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

function chatResponse(content: string): AiRuntimeResponse {
  return {
    provider: "test",
    model: "vision-model",
    content,
    reasoningContent: null,
    finishReason: "stop",
    promptTokens: 100,
    completionTokens: 20,
    elapsedMs: 10,
  };
}

const visionJson = JSON.stringify({
  observations: [
    {
      n: "血小板计数",
      r: "205",
      v: 205,
      u: "10^9/L",
      p: 1,
      q: "血小板计数 205 10^9/L 参考范围 125-350",
    },
  ],
});

test("runVisionReview returns null without touching AI when vision is disabled", async () => {
  await withAiSettings(false, async () => {
    let chatCalled = false;
    const result = await runVisionReview(
      {
        reportId: "report",
        result: emptyResult(),
        candidates: [candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L 参考范围 125-350")],
      },
      {
        loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
        chat: async () => {
          chatCalled = true;
          return chatResponse(visionJson);
        },
      },
    );
    assert.equal(result, null);
    assert.equal(chatCalled, false);
  });
});

test("runVisionReview reviews pages, accepts anchored observations and accumulates tokens", async () => {
  await withAiSettings(true, async () => {
    const events: AiVisionReviewEvent[] = [];
    const seenRequests: AiRuntimeRequest[] = [];
    const result = await runVisionReview(
      {
        reportId: "report",
        result: emptyResult(),
        candidates: [
          candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L 参考范围 125-350"),
          candidateLine("page-1", 1, 2, "备注：请结合临床"),
        ],
      },
      {
        onEvent: (event) => events.push(event),
        loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
        chat: async (_config: AiRuntimeConfig, request: AiRuntimeRequest) => {
          seenRequests.push(request);
          return chatResponse(visionJson);
        },
      },
    );
    assert.ok(result);
    assert.equal(result.model, "vision-model");
    assert.equal(result.promptTokens, 100);
    assert.equal(result.completionTokens, 20);
    assert.equal(result.fields.observations.length, 1);
    assert.equal(result.fields.observations[0].itemName, "血小板计数");
    assert.equal(result.fields.observations[0].evidence[0].source, "vision");
    // 多模态消息：文本候选行 + 图片
    const userContent = seenRequests[0].messages[1].content as Array<Record<string, unknown>>;
    assert.equal(userContent[0].type, "text");
    assert.match(String(userContent[0].text), /血小板计数 205/);
    assert.deepEqual(userContent[1], {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AAAA" },
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["vision_review_started", "vision_review_completed"],
    );
    assert.equal(events[1].detail.accepted, 1);
    assert.equal(events[1].detail.reviewedPages, 1);
  });
});

test("runVisionReview reports failure when every page review fails", async () => {
  await withAiSettings(true, async () => {
    const events: AiVisionReviewEvent[] = [];
    const result = await runVisionReview(
      {
        reportId: "report",
        result: emptyResult(),
        candidates: [candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L")],
      },
      {
        onEvent: (event) => events.push(event),
        loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
        chat: async () => {
          throw new Error("模拟网络失败");
        },
      },
    );
    assert.equal(result, null);
    assert.deepEqual(
      events.map((event) => event.type),
      ["vision_review_started", "vision_review_failed"],
    );
    assert.match(events[1].message, /模拟网络失败/);
  });
});

test("runVisionReview keeps partial results when one page fails", async () => {
  await withAiSettings(true, async () => {
    const events: AiVisionReviewEvent[] = [];
    let calls = 0;
    const result = await runVisionReview(
      {
        reportId: "report",
        result: emptyResult(),
        candidates: [
          candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L 参考范围 125-350"),
          candidateLine("page-2", 2, 1, "血红蛋白 130 g/L"),
        ],
      },
      {
        onEvent: (event) => events.push(event),
        loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
        chat: async () => {
          calls += 1;
          if (calls === 2) throw new Error("第二页超时");
          return chatResponse(visionJson);
        },
      },
    );
    assert.ok(result);
    assert.equal(result.fields.observations.length, 1);
    assert.equal(result.promptTokens, 100);
    const completed = events.find((event) => event.type === "vision_review_completed");
    assert.ok(completed);
    assert.equal(completed.detail.reviewedPages, 1);
    assert.deepEqual(completed.detail.failures, ["第 2 页：第二页超时"]);
  });
});

test("runVisionReview treats truncated or non-JSON responses as page failures", async () => {
  await withAiSettings(true, async () => {
    for (const response of [
      { ...chatResponse(visionJson), finishReason: "length" },
      { ...chatResponse("不是 JSON"), content: "不是 JSON" },
    ]) {
      const events: AiVisionReviewEvent[] = [];
      const result = await runVisionReview(
        {
          reportId: "report",
          result: emptyResult(),
          candidates: [candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L")],
        },
        {
          onEvent: (event) => events.push(event),
          loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
          chat: async () => response,
        },
      );
      assert.equal(result, null);
      assert.equal(events.at(-1)?.type, "vision_review_failed");
    }
  });
});

test("runVisionReview propagates job cancellation instead of swallowing it", async () => {
  await withAiSettings(true, async () => {
    await assert.rejects(
      runVisionReview(
        {
          reportId: "report",
          result: emptyResult(),
          candidates: [candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L")],
        },
        {
          shouldContinue: () => false,
          loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
          chat: async () => chatResponse(visionJson),
        },
      ),
      (error: unknown) =>
        (error as { code?: string })?.code === "AI_TASK_CANCELLED",
    );
  });
});

test("runVisionReview honors the AI_VISION_REVIEW_MAX_PAGES kill switch", async () => {
  await withAiSettings(true, async () => {
    process.env.AI_VISION_REVIEW_MAX_PAGES = "0";
    try {
      let chatCalled = false;
      const result = await runVisionReview(
        {
          reportId: "report",
          result: emptyResult(),
          candidates: [candidateLine("page-1", 1, 1, "血小板计数 205 10^9/L")],
        },
        {
          loadImage: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", bytes: 4 }),
          chat: async () => {
            chatCalled = true;
            return chatResponse(visionJson);
          },
        },
      );
      assert.equal(result, null);
      assert.equal(chatCalled, false);
    } finally {
      delete process.env.AI_VISION_REVIEW_MAX_PAGES;
    }
  });
});
