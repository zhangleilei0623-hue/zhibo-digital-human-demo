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
  const market = payload.market || "海外";
  const platform = payload.platform || "TikTok";
  const scenario = payload.scenario || payload.question || payload.text || "";

  if (route === "/api/generate-script") {
    return `请根据以下信息，为海外直播生成一段英文口播稿：\n目标市场：${market}\n直播平台：${platform}\n商品：${product}\n请生成一段自然、口语化、有吸引力的英文直播话术，用于吸引观众关注并介绍商品亮点。`;
  }

  if (route === "/api/danmu" || route === "/api/answer") {
    return `你是直播间主播，请根据观众的以下质疑/问题，生成主播的应答话术。要求口语化、自然、有说服力，能够化解疑虑并引导购买。\n\n观众质疑：${scenario}`;
  }

  if (route === "/api/score" || route === "/api/evaluate") {
    return `请作为直播话术评分专家，对以下主播回答进行评分，并指出存在的问题，给出优化建议。\n\n主播回答：${scenario}\n\n请以JSON格式返回评分结果，包含以下维度：合规性、话术服务、互动安排、转化能力、粤语/语言自然度，并给出综合评语和改进建议。`;
  }

  return `请处理以下请求：${JSON.stringify(payload)}`;
}

async function callCozeBot(route, payload) {
  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;

  if (!token || !botId) {
    return localFallback(route, payload);
  }

  const prompt = buildPrompt(route, payload);
  const answer = await streamCozeBot(prompt);
  return { text: answer || "智能体未返回有效内容" };
}

function localFallback(route, payload) {
  const product = payload.product || "直播商品";
  if (route === "/api/generate-script") {
    return {
      text: `Hi everyone, welcome to our live room. Today we are introducing ${product}. Please check the product card for details. If you have any questions, feel free to send them in the chat!`
    };
  }
  if (route === "/api/danmu" || route === "/api/answer") {
    return {
      text: `[本地备选] 感谢您的提问！${product} 是我们的热销产品，性价比很高，有任何疑问欢迎随时提问，我会一一解答。`
    };
  }
  if (route === "/api/score" || route === "/api/evaluate") {
    return {
      text: `[本地备选] 评分功能需要配置 COZE_API_TOKEN 和 COZE_BOT_ID 环境变量后使用 Coze 智能体进行分析。`
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
    const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
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
      return send(res, 200, { ok: true, text: data.text || data.report || "" });
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
