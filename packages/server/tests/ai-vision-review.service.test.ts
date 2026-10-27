import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
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
  assert.equal(accepted.length, 1);
  assert.equal(rejected, 2);
  assert.deepEqual(accepted[0].evidence, [
    {
      pageNumber: 1,
      quote: "血小板计数 205 10^9/L 参考范围 125-350",
      source: "vision",
    },
  ]);
});

test("acceptVisionObservations keeps same-name results from distinct source rows", () => {
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
  assert.deepEqual(accepted.map((item) => item.itemName), ["血红蛋白", "血小板计数"]);
  assert.equal(rejected, 0);
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
      headers: [{name:"X-Vision-Test",value:"synthetic-vision-header"}],
    });
    await run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test('vision admission verifies the item as well as its quote and preserves temporal occurrences', () => {
  const quote = '合成项目甲 入院 12 U/L 出院 24 U/L';
  const candidate = candidateLine('synthetic',1,1,quote);
  candidate.line.sourceLineIds = ['synthetic-name','synthetic-result'];
  candidate.line.box = [10,20,400,40];
  const group = groupVisionReviewPages([candidate])[0];
  const first = {...visionObservation('合成项目甲','12',quote), examination:{timeText:'入院'}};
  const second = {...visionObservation('合成项目甲','24',quote), examination:{timeText:'出院'}};
  const result = acceptVisionObservations([
    first,second,first,visionObservation('无关项目乙','99',quote),
    {...second,examination:{timeText:'未印出的日期'}},
  ],group,emptyResult());
  assert.equal(result.accepted.length,2);
  assert.equal(result.rejected,3);
  assert.deepEqual(result.accepted[0].evidence[0].visionRegion?.sourceLineIds,candidate.line.sourceLineIds);
  const normalized = normalizeAiExtraction({observations:result.accepted});
  assert.deepEqual(normalized.fields.observations[0].evidence[0].visionRegion?.box,[10,20,400,40]);
  assert.equal(acceptVisionObservations([first],group,emptyResult([first])).accepted.length,0);
});

test('visual name correction requires a trusted candidate, source region and unchanged result', () => {
  const quote = 'Y-谷氨酰转肽酶 | 18 | U/L';
  const candidate = candidateLine('synthetic',1,1,quote);
  Object.assign(candidate.line, {sourceLineIds:['name','value','unit'], box:[10,20,400,40],
    nameReviewCandidate:{originalName:'Y-谷氨酰转肽酶',suggestedName:'γ-谷氨酰转肽酶',canonicalKey:'synthetic-gamma',sourceLineIds:['name']}});
  const group = groupVisionReviewPages([candidate])[0];
  const corrected = {...visionObservation('γ-谷氨酰转肽酶','18',quote),unit:'U/L'};
  const result = acceptVisionObservations([corrected,
    {...corrected,itemName:'无关项目'}, {...corrected,resultText:'19',numericValue:19}],group,emptyResult());
  assert.equal(result.accepted.length,1);
  assert.equal(result.rejected,2);
  assert.equal(result.accepted[0].evidence[0].nameCorrected,true);
  const normalized = normalizeAiExtraction({observations:result.accepted}).fields.observations[0];
  assert.equal(normalized.evidence[0].nameCorrected,true);
  assert.equal(normalized.evidence[0].quote,quote);
  candidate.line.sourceLineIds=[];
  assert.equal(acceptVisionObservations([corrected],group,emptyResult()).accepted.length,0);
  candidate.line.sourceLineIds=['name','value','unit'];
  candidate.line.text=quote.replace('18','<18');
  assert.equal(acceptVisionObservations([{...corrected,evidence:[{pageNumber:1,quote:candidate.line.text}]}],group,emptyResult()).accepted.length,0);
});

test('visual re-reading can correct the value of an existing exact-source candidate', () => {
  const quote='合成项目甲 | 1.27 | U/L';
  const candidate=candidateLine('synthetic',1,1,quote);
  Object.assign(candidate.line,{sourceLineIds:['name','value','unit'],box:[10,20,400,40]});
  const group=groupVisionReviewPages([candidate])[0];
  const original={...visionObservation('合成项目甲','1.27',quote),unit:'U/L'};
  const corrected={...original,resultText:'1.21',numericValue:1.21};
  const result=acceptVisionObservations([original,corrected],group,emptyResult([original]));
  assert.equal(result.accepted.length,1);
  assert.equal(result.rejected,1);
  assert.equal(result.accepted[0].numericValue,1.21);
  assert.equal(result.accepted[0].evidence[0].quote,quote);
  assert.deepEqual(result.accepted[0].evidence[0].visionRegion?.sourceLineIds,['name','value','unit']);
});

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
          assert.equal(_config.headers?.["x-vision-test"],"synthetic-vision-header");
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

test('vision review cannot silently turn detection limits into exact measurements', () => {
  for (const bound of ['<', '>', '≤', '≥', '<=', '>=']) {
    const quote = `合成项目甲 ${bound}2 U/L`;
    const group = groupVisionReviewPages([candidateLine('p', 1, 1, quote)])[0];
    const incorrect = visionObservation('合成项目甲', '2', quote);
    assert.equal(acceptVisionObservations([incorrect], group, emptyResult()).accepted.length, 0);
    assert.equal(acceptVisionObservations([{ ...incorrect, resultText: `${bound}2` }], group, emptyResult()).accepted.length, 1);
  }
});

test('page review can recover an OCR-missed qualitative row without publishing it as verified', async () => {
  await withAiSettings(true, async () => {
    let calls = 0;
    const result = await runVisionReview({reportId:'r',result:emptyResult(),candidates:[],pageReviews:[{pageId:'p',pageNumber:1}]}, {
      loadImage:async () => ({dataUrl:'data:image/jpeg;base64,AAAA',bytes:4}),
      chat:async (_config, request) => {
        calls++;
        assert.match(String(request.messages[0].content), /整页/);
        return chatResponse(JSON.stringify({observations:[{n:'合成项目乙',r:'阴性',p:1,q:'合成项目乙 阴性'}]}));
      },
    });
    assert.equal(calls,1);
    assert.equal(result?.fields.observations.length,1);
    assert.equal(result?.fields.observations[0].evidence[0].imageOnly,true);
    const group = {pageId:'p',pageNumber:1,lines:[],omittedCandidates:0};
    assert.equal(acceptVisionObservations(result!.fields.observations,group,emptyResult()).accepted.length,0);
    assert.equal(acceptVisionObservations(result!.fields.observations,{...group,pageReview:true},result!).accepted.length,0);
  });
});

test('PDF vision cache uses the current rotation instead of an existing stale preview', async () => {
  await withAiSettings(true, async () => {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id,display_name) VALUES('u','合成用户');
      INSERT INTO health_members(id,display_name,created_by) VALUES('m','合成成员','u');
      INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES('r','m','u','laboratory','合成报告','ready');
      INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256,rotation)
      VALUES('p','r',1,'synthetic.pdf','synthetic.pdf','application/pdf',1,'synthetic',90);`);
    const cache = join(process.env.STORAGE_DIR!, 'previews','r');
    mkdirSync(cache,{recursive:true});
    writeFileSync(join(cache,'p.jpg'),'old');
    writeFileSync(join(cache,'p.r0.jpg'),'unrotated');
    writeFileSync(join(cache,'p.r90.jpg'),'rotated');
    let calls = 0;
    await runVisionReview({reportId:'r',result:emptyResult(),candidates:[candidateLine('p',1,1,'合成项目甲 12 U/L')]},{
      chat:async (_config,request) => {
        calls++;
        const parts = request.messages[1].content as Array<{type:string;image_url?:{url:string}}>;
        assert.equal(parts.find(part => part.type==='image_url')?.image_url?.url, `data:image/jpeg;base64,${Buffer.from('rotated').toString('base64')}`);
        return chatResponse('{"observations":[]}');
      },
    });
    assert.equal(calls,1);
  });
});

test('dense candidate lists keep the existing review limit instead of escalating to a whole-page response',async()=>{
  await withAiSettings(true,async()=>{
    let calls=0;
    const candidates=Array.from({length:13},(_,index)=>candidateLine('page-1',1,index,`合成指标${index} ${index+1} U/L`));
    const output=await runVisionReview({reportId:'report',result:emptyResult(),candidates},{
      loadImage:async()=>({dataUrl:'data:image/jpeg;base64,AAAA',bytes:4}),
      chat:async(_config,request)=>{
        calls++;assert.equal(request.maxOutputTokens,2048);
        return chatResponse(JSON.stringify({observations:[{n:'合成指标12',r:'13',u:'U/L',p:1,q:'合成指标12 13 U/L'}]}));
      }
    });
    assert.equal(calls,1);
    assert.equal(output?.fields.observations.length,0,'rows outside the original candidate list are not expanded implicitly');
  });
});


test('single Han names require an exact name/value region, including a glued table ordinal', () => {
  const lines = ['1钾 | 6.4 | mmol/L | 参考范围 1-9', '钠 8.6 mmol/L',
    '尿钾 6.4 mmol/L', '1型 6.4 U/L', '3钙 <6.4 mmol/L', '4镁 | 2.7 | mmol/L | 钾 | 6.4 | mmol/L'];
  const group = groupVisionReviewPages(lines.map((text,index) => candidateLine('page-1',1,index+1,text)))[0];
  const {accepted,rejected} = acceptVisionObservations([
    visionObservation('钾','6.4',lines[0]),
    visionObservation('钠','8.6',lines[1]),
    visionObservation('钾','1',lines[0]), // ordinal is not the measured value
    visionObservation('钾','9',lines[0]), // reference bound is not the result
    visionObservation('钾','6.4',lines[2]), // another specimen/project
    visionObservation('型','6.4',lines[3]), // medical qualifier is not an ordinal
    visionObservation('钙','6.4',lines[4]), // detection limit cannot become an exact point
    visionObservation('镁','6.4',lines[5]), // neighbouring result cannot be borrowed
  ],group,emptyResult());
  assert.deepEqual(accepted.map(item=>item.itemName),['钾','钠']);
  assert.equal(rejected,6);
});
