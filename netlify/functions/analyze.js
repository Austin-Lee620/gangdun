// netlify/functions/analyze.js
// POST /.netlify/functions/analyze
// Body: { text?: string, image?: string /* data:image/jpeg;base64,... */ }
// 返回: { ok:true, report:{ risk, score, summary, signals[], advice[] } }
//
// 安全要点：API Key 只读环境变量，永远不下发到浏览器；
// 请求 25s 超时 + 图片体积校验；任何异常都返回中文可读信息 + 降级报告，页面不崩。

const MIMO_URL = "https://api.mimo.com/v1/chat/completions";

// 模型无输出 / 超时时的兜底报告（前端会原样展示，并提示「内容未能完整识别」）
const FALLBACK_REPORT = Object.freeze({
  risk: "中危",
  score: 50,
  summary: "内容未能完整识别，建议你直接挂线或忽略，并通过官方渠道核实。",
  signals: ["未能完整读取图片/文本内容"],
  advice: ["拨打反诈骗协调中心热线 18222 求证", "如已转账请立即拨 999 报警并联系银行止付"]
});

const SYSTEM_PROMPT = `你是「港盾」AI 防诈助手，服务在香港读书或工作的青年与「港漂」，熟悉香港常见骗术：假冒官员（入境处/公检法/快递/银行）、傀儡户口（出租出借账户洗钱）、租房与换汇陷阱、假专才与杀猪盘、屏幕共享远程操控、虚假投资。
用户会发来一段可疑对话、短信或截图。请只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块，结构固定为：
{
  "risk": "高危|中危|低危",
  "score": 0-100 的整数,
  "summary": "一句话结论",
  "signals": ["风险特征1", "风险特征2", "风险特征3"],
  "advice": ["建议动作1", "建议动作2", "建议动作3"]
}
要求：signals 至少 2 条、最多 5 条；advice 至少 2 条、最多 5 条，优先包含「挂线」「拨打 18222 或 999」「通过官方渠道核实」「不要转账/不要共享屏幕/不要出租出借账户」这类明确动作；
如识别出「安全账户」「不要告诉任何人」「限时转账」「屏幕共享 App」「代收货款佣金」等信号，必须在 signals 中明确点出；
不确定时降低 score 而不是编造。绝不提供任何绕过金融风控、洗钱、代收代付的可行建议。`;

// ---- 工具函数 ----
function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(obj)
  };
}

function readBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null; // 区分「没有 body」和「body 非法」
  }
}

// dataURL → 解码后字节数（用于体积校验，单位 MB）
function dataUrlBytesMb(dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!m) return -1;
  return Math.round(Buffer.from(m[1], "base64").length / 1024 / 1024 * 10) / 10;
}

async function callMimo(payload, timeoutMs) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(MIMO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MIMO_API_KEY || ""}`
      },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`MiMo HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 尽力从模型输出里抠出 JSON（容忍 ```json 包裹、前后有废话的情况）
function extractJson(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(s); } catch (e) {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function normalizeReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const risk = ["高危", "中危", "低危"].includes(raw.risk) ? raw.risk : "中危";
  let score = parseInt(raw.score, 10);
  if (isNaN(score)) score = 50;
  score = Math.max(0, Math.min(100, score));
  const arr = (v) => (Array.isArray(v) ? v : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    risk,
    score,
    summary: String(raw.summary || FALLBACK_REPORT.summary).trim(),
    signals: arr(raw.signals).length ? arr(raw.signals) : FALLBACK_REPORT.signals,
    advice: arr(raw.advice).length ? arr(raw.advice) : FALLBACK_REPORT.advice
  };
}

exports.handler = async (event) => {
  // 只接受 POST
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "仅支持 POST 请求。" });
  }

  const body = readBody(event);
  if (body === null) {
    return json(400, { ok: false, error: "请求格式错误，不是合法 JSON。" });
  }

  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const image = typeof body.image === "string" ? body.image.trim() : "";

  if (!text && !image) {
    return json(400, { ok: false, error: "请上传截图或粘贴对话文字。" });
  }

  if (image) {
    const mb = dataUrlBytesMb(image);
    if (mb < 0) {
      return json(400, { ok: false, error: "图片格式不受支持，请使用 PNG / JPG / WebP。" });
    }
    if (mb > 5) {
      return json(413, { ok: false, error: "图片过大，请上传 5MB 以内的截图。" });
    }
  }

  if (!process.env.MIMO_API_KEY) {
    return json(503, {
      ok: false,
      error: "AI 服务未配置密钥，已切换到示例报告。",
      report: FALLBACK_REPORT
    });
  }

  // 组装消息：有图带图，没图纯文本
  const userContent = image
    ? [
        {
          type: "image_url",
          image_url: { url: image, detail: "high" }
        },
        {
          type: "text",
          text: text
            ? `以下是用户提供的可疑对话文本（以文本为准）：\n${text}`
            : "请分析这张截图里的骗术风险。"
        }
      ]
    : `请分析以下可疑对话：\n${text}`;

  const payload = {
    model: "mimo-vl",
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ]
  };

  try {
    const data = await callMimo(payload, 25000);
    const rawText =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
    const report = normalizeReport(extractJson(rawText));
    if (!report) {
      return json(200, {
        ok: true,
        report: FALLBACK_REPORT,
        note: "模型输出格式异常，已返回兜底建议"
      });
    }
    return json(200, { ok: true, report });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 超时单独给一句更清楚的话，方便你在 Netlify 日志里定位
    const timeout = /abort/i.test(msg) || /timeout/i.test(msg);
    return json(502, {
      ok: false,
      error: timeout ? "分析超时，已切换到示例报告。" : "AI 服务暂时不可用，已切换到示例报告。",
      report: FALLBACK_REPORT,
      detail: msg.slice(0, 300)   // 仅便于排错，前端不会展示
    });
  }
};