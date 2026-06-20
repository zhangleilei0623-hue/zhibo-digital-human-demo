const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;

const API_BASE = "https://api.coze.cn/v3/chat";

// 保留原有接口路径，内部统一调用 Coze 智能体
const ROUTES = ["/api/generate-script", "/api/danmu", "/api/score", "/api/answer", "/api/evaluate"];

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * 使用 fetch 流式请求 Coze 智能体 API，实时解析 SSE
 */
async function streamCozeBot(prompt) {
  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;

  if (!token || !botId) {
    throw new Error("缺少环境变量 COZE_API_TOKEN 或 COZE_BOT_ID");
  }

  const requestBody = {
    bot_id: botId,
    user_id: "local_digital_human_user",
    stream: true,
    auto_save_history: true,
    additional_messages: [
      {
        role: "user",
        content: prompt,
        content_type: "text"
      }
    ]
  };

  const response = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Accept": "text/event-stream"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Coze API 请求失败 ${response.status}: ${errText.slice(0, 300)}`);
  }

  // 实时读取流式响应体，解析 SSE
  const reader = response.body.getReader();
  let sseBuffer = "";
  let answer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += new TextDecoder().decode(value, { stream: true });

      // 找到完整的 event + data 块（用空行分隔）
      const parts = sseBuffer.split(/\n\n/);
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const eventLine = part.split(/\n/).find(l => l.startsWith("event:"));
        const dataLine = part.split(/\n/).find(l => l.startsWith("data:"));

        if (eventLine && dataLine) {
          const eventType = eventLine.slice(6).trim();
          const jsonStr = dataLine.slice(5).trim();

          try {
            const data = JSON.parse(jsonStr);
            if (eventType === "conversation.message.delta" && data.role === "assistant" && data.type === "answer") {
              if (typeof data.content === "string") {
                answer += data.content;
              }
            }
          } catch {
            // ignore
          }
        }
      }

      // 保留未完整处理的尾部
      sseBuffer = parts[parts.length - 1];
    }

    // 处理最后一块
    if (sseBuffer.trim()) {
      const lines = sseBuffer.split(/\n/);
      const eventLine = lines.find(l => l.startsWith("event:"));
      const dataLine = lines.find(l => l.startsWith("data:"));
      if (eventLine && dataLine) {
        const jsonStr = dataLine.slice(5).trim();
        try {
          const data = JSON.parse(jsonStr);
          if (data.role === "assistant" && data.type === "answer" && typeof data.content === "string") {
            answer += data.content;
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return answer;
}

/**
 * 根据接口路径构造对应的 prompt
 */
function buildPrompt(route, payload) {
  const product = payload.product || "商品";
  const market = payload.country || payload.market || "中国";
  const platform = payload.platform || "TikTok";
  const scenario = payload.scenario || payload.scenarioType || payload.question || payload.text || "";
  const answer = payload.answer || "";

  if (route === "/api/generate-script") {
    return `你是“智播云枢”的合规脚本智能体。请根据以下信息生成一段可直接给数字人口播的直播脚本。
商品：${product}
目标市场：${market}
直播平台：${platform}
要求：
1. 如果目标市场是中国，输出中文；如果是美国/韩国/日本/巴西/俄罗斯/东南亚，优先输出适合该市场的英文或中英混合表达。
2. 语言自然、口语化、有直播间互动感。
3. 避免“全网最低、百分百有效、保证、绝对、根治”等高风险表达。
4. 只返回 JSON：{"script":"..."}，不要输出 Markdown。`;
  }

  if (route === "/api/danmu") {
    return `你是“智播云枢”的弹幕预练智能体。请为数字人直播间生成 3-5 条真实观众弹幕。
商品：${product}
目标市场：${market}
直播平台：${platform}
场景类型：${scenario}
要求：
1. 如果目标市场是中国，必须输出中文弹幕；如果是韩国、日本、俄罗斯、巴西等市场，可输出中文说明或适合该市场的简短外语表达。
2. 弹幕要像真实直播观众提出的问题，可以包含价格、物流、售后、使用方法、竞品比较等。
3. 不要生成攻击性、违法或敏感内容。
4. 只返回 JSON：{"danmu":["弹幕1","弹幕2","弹幕3"]}，不要输出 Markdown。`;
  }

  if (route === "/api/answer") {
    return `你是直播间主播教练，请针对以下观众问题生成一段合规、自然、有说服力的主播回答。
商品：${product}
观众问题：${scenario}
只返回 JSON：{"answer":"..."}，不要输出 Markdown。`;
  }

  if (route === "/api/score" || route === "/api/evaluate") {
    return `你是“智播云枢”的直播训练评分智能体。请对主播回答进行五维评分并生成训练报告。
商品：${product}
目标市场：${market}
直播平台：${platform}
训练场景：${scenario}
主播回答：${answer}
评分维度必须是：合规性、说服力、情绪安抚、转化能力、口语自然度。
每个分数为 0-100 的整数。
报告要包含：训练对象、目标市场、平台、场景、综合得分、主要问题、优化建议、可直接照读的优化话术。
只返回 JSON：{"scores":{"合规性":88,"说服力":82,"情绪安抚":85,"转化能力":80,"口语自然度":86},"report":"..."}，不要输出 Markdown。`;
  }

  return `请处理以下请求：${JSON.stringify(payload)}`;
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalize(route, rawText, payload) {
  const parsed = typeof rawText === "object" ? rawText : extractJsonObject(rawText);
  const text = typeof rawText === "string" ? rawText.trim() : "";

  if (route === "/api/generate-script") {
    return {
      script: parsed?.script || text || localFallback(route, payload).script
    };
  }

  if (route === "/api/danmu") {
    if (Array.isArray(parsed?.danmu)) return { danmu: parsed.danmu.map(String).slice(0, 6) };
    const lines = text
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 6);
    return { danmu: lines.length ? lines : localFallback(route, payload).danmu };
  }

  if (route === "/api/score" || route === "/api/evaluate") {
    if (parsed?.scores && parsed?.report) return { scores: parsed.scores, report: String(parsed.report) };
    return localFallback(route, payload);
  }

  if (route === "/api/answer") {
    return { answer: parsed?.answer || text };
  }

  return { text };
}

async function callCozeBot(route, payload) {
  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;

  if (!token || !botId) {
    return localFallback(route, payload);
  }

  const prompt = buildPrompt(route, payload);
  const answer = await streamCozeBot(prompt);
  return normalize(route, answer || "", payload);
}

function localFallback(route, payload) {
  const product = payload.product || "直播商品";
  if (route === "/api/generate-script") {
    return {
      script: `Hi everyone, welcome to our live room. Today we are introducing ${product}. Please check the product card for details. If you have any questions, feel free to send them in the chat!`
    };
  }
  if (route === "/api/danmu") {
    return {
      danmu: [
        `${product} 和其他同类产品有什么区别？`,
        "今天直播间有什么优惠？",
        "多久可以发货，售后怎么处理？",
        "适合第一次购买的人吗？"
      ]
    };
  }
  if (route === "/api/answer") return { answer: `感谢您的提问！${product} 是我们的主推产品，具体优惠和发货信息以商品卡为准，我也可以继续帮您说明使用方法和售后规则。` };
  if (route === "/api/score" || route === "/api/evaluate") {
    return {
      scores: {
        "合规性": 88,
        "说服力": 78,
        "情绪安抚": 82,
        "转化能力": 76,
        "口语自然度": 86
      },
      report:
        `本地备选评分：桥接服务已运行，但尚未配置 Coze 智能体参数。\n` +
        `训练对象：${product}\n` +
        `训练场景：${payload.scenario || "未填写"}\n\n` +
        `建议：避免绝对化承诺，补充商品卡、物流、售后等具体信息，并用自然话术引导用户继续提问或下单。`
    };
  }
  return { text: `[本地备选] 收到请求，route: ${route}` };
}

function serveFile(req, res) {
  const urlPath = req.url === "/" ? "/zhibo-digital-human-demo.html" : req.url;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(urlPath.split("?")[0])));
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".css":"text/css"}; const type = mimeMap[ext] || "text/plain; charset=utf-8";
    send(res, 200, data, type);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.url === "/api/health") {
    const mode = process.env.COZE_API_TOKEN && process.env.COZE_BOT_ID ? "coze-bot-ready" : "local-fallback";
    return send(res, 200, { ok: true, mode });
  }
  if (req.method === "POST" && ROUTES.includes(req.url)) {
    try {
      const payload = await readBody(req);
      const data = await callCozeBot(req.url, payload);
      return send(res, 200, { ok: true, ...data });
    } catch (error) {
      return send(res, 500, { ok: false, error: error.message });
    }
  }
  if (req.method === "GET") return serveFile(req, res);
  send(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  const hasToken = !!process.env.COZE_API_TOKEN;
  const hasBotId = !!process.env.COZE_BOT_ID;
  if (hasToken && hasBotId) {
    console.log(`直播数字人 Coze Bridge (智能体模式) running: http://localhost:${PORT}`);
    console.log(`Bot ID: ${process.env.COZE_BOT_ID}`);
  } else {
    console.log(`直播数字人 Coze Bridge (本地备选模式) running: http://localhost:${PORT}`);
    console.log(`未配置 COZE_API_TOKEN 或 COZE_BOT_ID，将使用本地备选数据`);
  }
  console.log(`访问网页: http://localhost:${PORT}/zhibo-digital-human-demo.html`);
});
