# 智播云枢数字人直播实训 Demo

## Render 部署方式

本项目需要部署为 Render 的 **Web Service**，不要只部署成 Static Site。  
网页和 Coze 桥接接口由同一个 Node.js 服务提供。

### Build Command

```bash
npm install
```

### Start Command

```bash
npm start
```

### Environment Variables

在 Render Dashboard 的 Environment 中添加：

```text
COZE_API_TOKEN=你的 Coze 个人访问令牌
COZE_BOT_ID=你的 Coze 智能体 Bot ID
```

如果你的智能体在国际版 Coze，可以按实际接口域名扩展服务端配置；当前默认使用扣子中国接口：

```text
https://api.coze.cn/v3/chat
```

### 访问地址

部署成功后访问：

```text
https://zhibo-digital-human-demo.onrender.com
```

健康检查：

```text
https://zhibo-digital-human-demo.onrender.com/api/health
```

如果返回：

```json
{"ok":true,"mode":"coze-bot-ready"}
```

说明 Coze 智能体已经接入成功。
