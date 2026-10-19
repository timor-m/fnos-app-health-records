import { describe, expect, it } from "vitest";
import { feedbackEnvironment } from "../src/utils/feedback-environment";
describe("feedback environment allowlist", () => {
  it("selects safe fields and identifies Edge without sending the raw user agent", () => {
    const source = { appVersion: "1.0", accessMode: "port", secret: "SYNTHETIC_SECRET", database: { appliedSchemaVersion: 17, schemaVersion: 18 } };
    const result = feedbackEnvironment(source, { userAgent: "Windows Chrome/130.0 Safari/537.36 Edg/130.1", width: 400, height: 800 });
    expect(result).toContainEqual({ label: "浏览器", value: "Edge 130.1" });
    expect(result).toContainEqual({ label: "数据库版本", value: "v17" });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    expect(JSON.stringify(result)).not.toContain("Safari/537.36");
    expect(JSON.stringify(result)).not.toContain("Docker");
  });
  it("keeps client information when server information is unavailable", () => {
    const result = feedbackEnvironment(null, { userAgent: "unknown", width: 360, height: 740 });
    expect(result).toContainEqual({ label: "应用版本", value: "未获取" });
    expect(result).toContainEqual({ label: "页面尺寸", value: "360 × 740" });
    expect(result).toContainEqual({ label: "浏览器", value: "未获取" });
  });
});

describe('AI environment snapshots',()=>{
 it('shows the same current configuration in preview, payload and saved detail',async()=>{
  const {feedbackEnvironmentPayload,feedbackSnapshotDisplay}=await import('../src/utils/feedback-environment');
  const ai={enabled:true,visionEnabled:true,provider:'custom',model:'namespace/text:8b',visionModel:'vision-v1',extractionDepth:'detailed' as const};
  const client={userAgent:'unknown',width:800,height:600};
  const payload=feedbackEnvironmentPayload({ai},client);
  expect(payload.ai).toEqual(ai);
  for(const item of [{label:'AI 服务商',value:'自定义'},{label:'AI 提取模型（提交时配置）',value:ai.model},{label:'AI 视觉模型（提交时配置）',value:ai.visionModel},{label:'AI 解析程度',value:'详细'}]) {
   expect(feedbackEnvironment({ai},client)).toContainEqual(item);
   expect(feedbackSnapshotDisplay(payload)).toContainEqual(item);
  }
  expect(feedbackEnvironmentPayload({ai:{...ai,enabled:false}},client).ai).toEqual({enabled:false,visionEnabled:true});
  expect(feedbackEnvironmentPayload({ai:{...ai,visionEnabled:false}},client).ai).not.toHaveProperty('visionModel');
  expect(feedbackSnapshotDisplay({ai:{enabled:true,visionEnabled:false}})).toHaveLength(2);
  expect(JSON.stringify(feedbackSnapshotDisplay({ai:{...ai,model:'sk-synthetic'}}))).not.toContain('sk-synthetic');
  expect(feedbackSnapshotDisplay({ai:{...ai,model:'port'}})).toContainEqual({label:'AI 提取模型（提交时配置）',value:'port'});
 });
});
