import { feedbackAiSnapshot, type FeedbackAiSnapshot } from '../../../shared/feedback-ai';

export type FeedbackEnvironment = Array<{ label: string; value: string }>;
export type FeedbackAbout = {
  appVersion?: string;
  deployment?: string;
  kernelVersion?: string;
  ocr?: { available: boolean; engine?: string | null; modelVersion?: string | null; pythonVersion?: string | null; rapidocrVersion?: string | null; pymupdfVersion?: string | null; tableModel?: boolean | null; layoutModel?: boolean | null } | null;
  ai?: FeedbackAiSnapshot | null;
  accessMode?: string;
  runtime?: { node?: string; platform?: string; arch?: string };
  database?: { appliedSchemaVersion?: number };
};

// Explicit allowlist: never copy the response, user agent or configuration wholesale.
export function feedbackEnvironment(about: FeedbackAbout | null, client: { userAgent: string; width: number; height: number }): FeedbackEnvironment {
  const ua = client.userAgent;
  const browser = ua.match(/(Edg)\/([\d.]+)/) ?? ua.match(/(Firefox|Chrome|CriOS|FxiOS)\/([\d.]+)/);
  const safari = ua.match(/Version\/([\d.]+).*Safari/);
  const names: Record<string, string> = { Edg: "Edge", Firefox: "Firefox", Chrome: "Chrome", CriOS: "Chrome", FxiOS: "Firefox" };
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS / iPadOS" : /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "macOS / iPadOS" : /Linux/.test(ua) ? "Linux" : "未获取";
  const state = (value: boolean | null | undefined) => value == null ? "未获取" : value ? "是" : "否";
  return [
    { label: "应用版本", value: about?.appVersion || "未获取" },
    { label: "部署环境", value: about?.deployment || "未获取" },
    { label: "系统内核", value: about?.kernelVersion || "未获取" },
    { label: "接入方式", value: about?.accessMode === "gateway" ? "网关访问" : about?.accessMode === "port" ? "端口直连" : "未获取" },
    { label: "数据库版本", value: about?.database?.appliedSchemaVersion == null ? "未获取" : `v${about.database.appliedSchemaVersion}` },
    { label: "服务端系统", value: about?.runtime?.platform || "未获取" },
    { label: "系统架构", value: about?.runtime?.arch || "未获取" },
    { label: "Node.js", value: about?.runtime?.node || "未获取" },
    { label: "浏览器", value: browser ? `${names[browser[1]]} ${browser[2]}` : safari ? `Safari ${safari[1]}` : "未获取" },
    { label: "客户端系统", value: os },
    { label: "页面尺寸", value: `${client.width} × ${client.height}` },
    { label: "OCR 可用", value: state(about?.ocr?.available) },
    { label: "OCR 引擎", value: about?.ocr?.engine || "未获取" },
    { label: "OCR 模型版本", value: about?.ocr?.modelVersion || "未获取" },
    { label: "Python", value: about?.ocr?.pythonVersion || "未获取" },
    { label: "RapidOCR", value: about?.ocr?.rapidocrVersion || "未获取" },
    { label: "PyMuPDF", value: about?.ocr?.pymupdfVersion || "未获取" },
    { label: "表格识别可用", value: state(about?.ocr?.tableModel) },
    { label: "版面分析可用", value: state(about?.ocr?.layoutModel) },
    ...(about?.ai ? feedbackSnapshotDisplay({ai:about.ai}) : [
      { label: "AI 已启用", value: state(undefined) },
      { label: "AI 视觉增强", value: state(undefined) }
    ])
  ];
}

export function feedbackEnvironmentPayload(about: FeedbackAbout | null, client: {userAgent:string;width:number;height:number}) {
  const display=feedbackEnvironment(about,client);
  const browser=display.find(i=>i.label==='浏览器')!.value;
  const split=browser.lastIndexOf(' ');
  const payload:Record<string,Record<string,unknown>>={
    app:{version:about?.appVersion ?? null},
    deployment:{type:({'Docker':'docker','fnOS':'fnos','开发环境':'development'} as Record<string,string>)[about?.deployment||'']||'unknown',accessMode:['port','gateway'].includes(about?.accessMode||'')?about!.accessMode:'unknown'},
    server:{platform:about?.runtime?.platform??null,arch:about?.runtime?.arch??null,kernelVersion:about?.kernelVersion??null,nodeVersion:about?.runtime?.node??null},
    database:{schemaVersion:about?.database?.appliedSchemaVersion??null},
    client:{browserName:split<0?null:browser.slice(0,split),browserVersion:split<0?null:browser.slice(split+1),osName:display.find(i=>i.label==='客户端系统')!.value,viewportWidth:client.width,viewportHeight:client.height}
  };
  if(about?.ocr) payload.ocr=Object.fromEntries(['available','engine','modelVersion','pythonVersion','rapidocrVersion','pymupdfVersion','tableModel','layoutModel'].map(k=>[k,(about.ocr as Record<string,unknown>)[k]??null]));
  if(about?.ai) payload.ai=feedbackAiSnapshot(about.ai);
  return payload;
}

export function feedbackSnapshotDisplay(snapshot?:Record<string,Record<string,unknown>>):FeedbackEnvironment {
  const fields:Record<string,Record<string,string>>={app:{version:'应用版本'},deployment:{type:'部署环境',accessMode:'接入方式'},server:{platform:'服务端系统',arch:'系统架构',kernelVersion:'系统内核',nodeVersion:'Node.js'},database:{schemaVersion:'数据库版本'},client:{browserName:'浏览器',browserVersion:'浏览器版本',osName:'客户端系统',viewportWidth:'页面宽度',viewportHeight:'页面高度'},ocr:{available:'OCR 可用',engine:'OCR 引擎',modelVersion:'OCR 模型版本',pythonVersion:'Python',rapidocrVersion:'RapidOCR',pymupdfVersion:'PyMuPDF',tableModel:'表格识别可用',layoutModel:'版面分析可用'},ai:{enabled:'AI 已启用',visionEnabled:'AI 视觉增强',provider:'AI 服务商',model:'AI 提取模型（提交时配置）',visionModel:'AI 视觉模型（提交时配置）',extractionDepth:'AI 解析程度'}};
  const values:Record<string,string>={fnos:'fnOS',docker:'Docker',development:'开发环境',gateway:'网关访问',port:'端口直连',unknown:'未获取'};
  const ai = snapshot?.ai ? feedbackAiSnapshot({...snapshot.ai,enabled:snapshot.ai.enabled===true,visionEnabled:snapshot.ai.visionEnabled===true}) : null;
  const providers:Record<string,string>={deepseek:'DeepSeek',kimi:'Kimi',glm:'GLM',qwen:'Qwen',openai:'OpenAI',doubao:'豆包',minimax:'MiniMax',ollama:'Ollama',custom:'自定义'};
  return Object.entries(fields).flatMap(([group,labels])=>Object.entries(labels)
    .filter(([key])=>snapshot?.[group] && Object.prototype.hasOwnProperty.call(snapshot[group],key))
    .map(([key,label])=>{
      const value = group==='ai' && !['enabled','visionEnabled'].includes(key)
        ? ai?.[key as keyof FeedbackAiSnapshot] : snapshot![group][key];
      const text = value==null ? '未获取' : typeof value==='boolean' ? (value?'是':'否')
        : group==='ai' ? key==='provider' ? providers[String(value)] || String(value)
          : key==='extractionDepth' ? ({overview:'概要',detailed:'详细'} as Record<string,string>)[String(value)] || String(value) : String(value)
        : values[String(value)] || String(value);
      return {label,value:text};
    }));
}
