# Yunzai DeepSeek Chat

一个用于 Yunzai 的 DeepSeek 对话插件。它可以处理 QQ 私聊与群聊消息，并提供上下文记忆、群聊公共记忆、对话归档、用量统计、黑名单、聊天记录导出和群成员互动分析。

本项目按 Linux 上的 Yunzai 部署方式编写安装说明。插件代码使用 ECMAScript Modules，运行数据默认保存在 Yunzai 工作目录下的 `data/aitalk/`。

## 功能

- 私聊和群聊自然语言对话
- 用户上下文与群聊公共记忆
- 长上下文自动归档和摘要
- Token 用量、聊天与社交统计
- 群和用户黑名单
- 对话记录、群聊记录导出
- API 请求重试、冷却与速率限制
- 可关闭的群聊随机冒泡

## 运行要求

- Linux
- Node.js 18 或更高版本
- 已可正常运行的 Yunzai，且插件入口兼容 `lib/plugins/plugin.js`
- DeepSeek 或兼容 OpenAI Chat Completions 接口的服务
- `node-fetch@3`

## 安装

以下命令都在 Linux 终端执行。将 `/path/to/Yunzai` 换成你的 Yunzai 实际目录。

```bash
cd /path/to/Yunzai
git clone https://github.com/help660vip/Yunzai-DeepSeek-Chat-Plugins.git \
  plugins/Yunzai-DeepSeek-Chat-Plugins
```

在 Yunzai 根目录安装依赖。使用项目当前采用的包管理器，不要混用 lockfile。

```bash
# pnpm
pnpm add node-fetch@3

# 或 npm
npm install node-fetch@3
```

配置环境变量后重启 Yunzai：

```bash
export DEEPSEEK_API_KEY='替换为你的 API Key'
export API_BASE_URL='https://api.deepseek.com'
export API_MODEL_NAME='deepseek-v4-flash'
```

插件读取以下环境变量：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 首选 API Key |
| `SILICONFLOW_API_KEY` | 否 | 未设置 `DEEPSEEK_API_KEY` 时使用 |
| `API_BASE_URL` | 否 | API 根地址，默认 `https://api.deepseek.com` |
| `API_MODEL_NAME` | 否 | 模型名称，默认 `deepseek-v4-flash` |
| `API_MAX_TOKENS` | 否 | 可选输出 Token 上限；不设置时由 API 服务商决定 |

插件本身不会读取任意位置的 `.env` 文件。如果你的 Yunzai 启动器不会自动载入 `.env`，请在 systemd、PM2、Docker Compose 或启动脚本中设置环境变量。

PM2 用户修改环境变量后可执行：

```bash
pm2 restart yunzai --update-env
```

进程名不是 `yunzai` 时，请替换为 `pm2 list` 中显示的实际名称。

## 回复触发与随机冒泡

群聊中的回复分为主动触发和随机冒泡：

| 场景 | 是否受 `randomBubbleChance` 控制 |
| --- | --- |
| 私聊消息 | 否，正常触发 |
| 群聊中 @ 机器人 | 否，正常触发 |
| 群聊中回复机器人消息 | 否，正常触发 |
| 普通群消息的随机冒泡 | 是 |

在 `config/config.js` 中设置：

```javascript
export const LIMITS = {
  // 其他配置……
  randomBubbleChance: 0
}
```

`randomBubbleChance` 的取值范围是 `0` 到 `1`：

- `0`：完全关闭普通群消息的随机冒泡
- `0.01`：每条普通群消息有 1% 概率触发
- `1`：每条普通群消息都触发

修改配置后必须重启 Yunzai。设置为 `0` 只关闭随机冒泡，不会禁用私聊、@机器人或回复机器人消息。

## 语气与回答长度

默认语气是平静、克制、自然和友好，不主动表现得过分热情或熟络。模型会跟随对方的情绪强度，但不会比对方更兴奋，也会减少感叹号、夸张赞美、连续附和和固定客套话。

克制不等于冷淡。简单聊天会直接接话，不先复述问题，也不固定添加开场或结尾。

插件不按字符数、行数或固定 Token 数截断正常对话，而是让模型根据问题性质决定篇幅：

- 寒暄、情绪表达、玩笑、简单事实和普通闲聊：像真人聊天一样简短，通常一两句话说完。
- 学科知识、技术、代码、原理分析、作业辅导、方案和创作：根据复杂度完整回答，不要求用户必须写“详细”。
- 用户明确要求“简短”或“详细”时，以用户要求为准。

普通对话默认不会发送 `max_tokens`。如果服务商必须限制输出，或你希望控制费用，可以通过 `API_MAX_TOKENS` 主动设置上限。

## 常用配置

主要运行参数位于 `config/config.js` 的 `LIMITS`：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `maxContext` | 500 | 单个用户对话上下文最大条数 |
| `maxPublicMemory` | 100 | 群公共记忆最大条数 |
| `archiveThreshold` | 400 | 自动归档阈值 |
| `cooldownMs` | 3000 | 同一用户回复冷却时间，单位毫秒 |
| `rateLimitPerMinute` | 10 | 单个用户每分钟请求上限 |
| `randomBubbleChance` | 0 | 普通群消息随机冒泡概率 |

API 的重试次数、超时和系统提示词也在同一文件中配置。不要把 API Key 直接写入源码或提交到 Git。

## 指令

### 普通用户

| 指令 | 说明 |
| --- | --- |
| `#清空我的上下文` | 清空当前对话上下文、对应归档和已提取的个人信息 |
| `#对话统计` | 生成自己的对话统计 |
| `#查询关系 @A @B` | 分析两名群成员的互动关系 |
| `#群关系图` | 查看群内互动概览 |
| `#我的社交统计` | 查看自己的群内互动统计 |

### 主人权限

| 指令 | 说明 |
| --- | --- |
| `#删除全部上下文` | 删除全部上下文、归档和重要信息 |
| `#查看上下文条数` | 查看上下文存储统计 |
| `#你用了多少 token` | 查看 API Token 用量 |
| `#归档上下文` | 手动归档较长上下文 |
| `#对话拉黑群 群号` | 将群加入黑名单 |
| `#对话拉黑人 QQ号` | 将用户加入黑名单 |
| `#对话解除拉黑群 群号` | 解除群黑名单 |
| `#对话解除拉黑人 QQ号` | 解除用户黑名单 |
| `#对话黑名单` | 查看黑名单 |
| `#对话调试模式 开启` | 开启调试输出 |
| `#对话调试模式 关闭` | 关闭调试输出 |
| `#导出对话记录 @用户` | 导出指定用户的对话记录 |
| `#导出群聊天记录` | 导出当前群的公共记忆 |

指令是否可用还取决于当前 Yunzai 适配器提供的群、引用消息和主人权限字段。

## 数据目录

数据默认写入 Yunzai 进程工作目录下的 `data/aitalk/`：

| 路径 | 内容 |
| --- | --- |
| `context.json` | 对话上下文 |
| `stats.json` | Token 使用统计 |
| `important.json` | 提取的用户信息 |
| `archive.json` | 对话归档摘要 |
| `blacklist.json` | 群和用户黑名单 |
| `relationships.json` | 群成员互动数据 |
| `meta.json` | 备份元数据 |
| `backup/` | 自动备份，默认保留 7 天 |
| `exports/` | 导出的文本记录 |

会直接影响模型回答的是 `context.json`、`archive.json` 和 `important.json`。其中群聊公共记忆也保存在 `context.json`。旧的机器人回复可能让模型模仿以前的篇幅，因此插件会明确要求只参考历史事实，不模仿历史回答长度。

`backup/`、`exports/`、`stats.json` 和 `relationships.json` 不会直接注入普通聊天提示词。

Linux 上请确保运行 Yunzai 的用户对该目录有读写权限：

```bash
cd /path/to/Yunzai
mkdir -p data/aitalk
chown -R yunzai:yunzai data/aitalk
```

`yunzai:yunzai` 只是示例，请替换为实际运行账户。不要直接使用 `chmod -R 777`。

## 项目结构

```text
.
├── config/config.js       # API、限制、提示词和指令路由
├── services/api.js        # API 请求与重试
├── services/chat.js       # 消息处理与对话流程
├── services/social.js     # 群成员互动统计
├── services/storage.js    # 本地数据存储、备份与导出
├── utils/tools.js         # 消息清理、检测与触发判断
├── index.js               # Yunzai 插件入口
├── ds.js                  # 兼容导出入口
└── test/                  # Node.js 回归测试
```

## 故障排查

### 提示未配置 API Key

先在 Yunzai 进程内确认环境变量可见。终端里执行过 `export`，不代表 systemd、PM2 或容器中的进程能读取到它。更新进程配置后完整重启。

### 随机冒泡设为 0 后仍看到回复

确认已经重启 Yunzai，并区分普通群消息与以下主动触发：私聊、@机器人、回复机器人消息。概率为 `0` 时，普通群消息不会进行随机抽样；事件只提供 `group_id` 而没有 `isGroup` 的适配器也会按群消息处理。

### 旧数据会不会影响回答风格

会。当前对话、群公共记忆和归档摘要都会进入模型上下文，旧的长回复可能让模型继续模仿这种风格。更新插件后先重启 Yunzai；如果仍受旧数据影响，可发送 `#清空我的上下文`。

该指令会清除当前会话的个人上下文、对应归档和已提取的个人信息，但不会删除整个群的公共记忆。主人需要彻底重置所有对话和群公共记忆时，可以使用 `#删除全部上下文`。`backup/` 中的备份不会被聊天流程自动读取。

### API 请求失败

检查 `API_BASE_URL` 是否包含服务商要求的版本路径、`API_MODEL_NAME` 是否为该服务商支持的模型名，并查看 Yunzai 日志中的 HTTP 状态码。代理、DNS 和防火墙也可能导致 Linux 服务器无法连接 API。

### 无法写入数据

确认 Yunzai 的工作目录正确，并让运行账户拥有 `data/aitalk/` 的读写权限。容器部署时还需要为该目录挂载持久卷。

## 测试

本项目的回归测试只使用 Node.js 内置测试运行器：

```bash
npm test
```

## 隐私与安全

对话上下文、互动数据和导出记录会保存在本机。部署者应告知群成员数据用途，限制数据目录和导出文件的访问权限，并按需要制定清理与备份策略。

API Key 只应通过环境变量或部署平台的 Secret 管理功能注入。若 Key 曾被提交、粘贴到公开日志或写入可共享文件，请立即在服务商控制台撤销并重新生成。

## 反馈与贡献

问题与建议请提交到 [GitHub Issues](https://github.com/help660vip/Yunzai-DeepSeek-Chat-Plugins/issues)。提交代码前请先运行 `npm test`，并避免提交 `data/`、日志、导出记录和任何凭据。
