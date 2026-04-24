# Bili2You - YouTube 视频加载 B 站弹幕

## ✨ 功能特性

### 🔄 弹幕同步
- 从 Bilibili 获取视频弹幕并在 YouTube 播放器上实时显示
- 支持滚动弹幕（模式 1）、顶部固定弹幕（模式 5）、底部固定弹幕（模式 4）
- 保留原始弹幕颜色与字号
- 支持全屏模式下弹幕正常显示

### 🤖 智能匹配
- **UP主映射**：建立 YouTube 频道与 B站 UP主的持久关联
- **自动匹配**：根据视频标题自动搜索并匹配对应的 B站视频
- **匹配度评分**：基于 Jaccard 相似度算法（词级 + 字符级），支持繁简中文转换
- **智能搜索策略**：优先在 UP主空间内搜索，匹配失败后回退到全站搜索
- **匹配度 ≥ 80%** 自动加载弹幕，低于阈值时需手动确认
- **手动搜索**：支持手动搜索并选择 B站视频

### ⚙️ 丰富设置
- **时间偏移**：调整弹幕时间轴，解决视频时长差异问题
- **字体大小**：12px - 36px 可调节
- **不透明度**：10% - 100% 可调节
- **滚动速度**：5s - 20s 可调节
- **弹幕密度**：25% / 50% / 75% / 100% 可选
- **屏幕高度**：控制弹幕显示区域（20% - 100%）
- **显示开关**：一键开关弹幕显示
- 所有设置通过 `chrome.storage.local` 持久化，实时同步到播放页面

### 📋 弹幕预览
- 加载后可预览所有弹幕列表
- 按时间顺序显示弹幕内容
- 支持虚拟滚动，流畅显示大量弹幕

---

## 📦 安装方法

### 开发者模式安装

1. 下载或克隆此项目到本地
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`
3. 开启右上角的 **开发者模式**
4. 点击 **加载已解压的扩展程序**
5. 选择项目文件夹

> 无需任何构建步骤，直接加载即可使用。

---

## 🚀 使用方法

### 首次使用

1. 打开 YouTube 视频页面
2. 点击浏览器右上角的 Bili2You 扩展图标
3. **建立频道映射（一次性）**：
   - 搜索对应的 B站 UP主
   - 点击选择，建立 YouTube 频道与 B站 UP主的关联
4. 扩展会自动匹配并加载对应的 B站弹幕

### 自动加载

- 一旦建立了频道映射，下次访问该频道的视频时会自动尝试匹配和加载弹幕
- 匹配度 ≥ 80% 时自动加载
- 匹配度较低时需要手动确认或搜索
- 支持 YouTube SPA 页面导航自动检测，切换视频无需刷新

### 手动加载

1. 点击"更换"按钮可以手动搜索视频
2. 从搜索结果中选择正确的 B站视频
3. 点击"加载弹幕"按钮

---

## 📁 项目结构

```
bili2You/
├── manifest.json          # 扩展配置文件 (Manifest V3)
├── background.js          # 后台服务 (API 代理、WBI 签名、Protobuf 解析、自动匹配)
├── popup/                 # 弹出页面
│   ├── popup.html         # 弹出页面结构
│   ├── popup.css          # 弹出页面样式 (暗色主题)
│   └── popup.js           # 弹出页面逻辑 (搜索、匹配、设置)
├── src/content/           # 内容脚本
│   ├── youtube.js         # YouTube 页面弹幕渲染与注入
│   └── youtube.css        # 弹幕样式
├── lib/
│   └── opencc-t2cn.js     # 繁体转简体中文转换库
└── icons/                 # 扩展图标
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🔧 技术实现

### 架构概览

```
YouTube 页面 (Content Script)
    ↕ chrome.runtime.sendMessage
Background Service Worker
    ↕ fetch (WBI 签名)
Bilibili API
    ↕
Popup UI ↔ Background ↔ Content Script
```

### API 调用与鉴权
- 使用 Bilibili 官方 API 搜索视频、UP主和获取弹幕
- 实现 **WBI 签名系统**：通过 Bilibili 专有的置换表生成 `mixin_key`，对请求参数进行 MD5 签名（`w_rid`），签名密钥缓存 30 分钟
- 内置纯 JavaScript MD5 哈希实现
- 通过 Background Service Worker 代理请求，避免 CORS 限制
- 指数退避重试机制（最多 5 次：500ms → 1s → 2s → 4s → 8s）

### 弹幕数据处理
- 弹幕按 6 分钟分段获取（`seg.so` 接口）
- 内置轻量级 **Protobuf 解析器**，解析 `DmSegMobileReply` 二进制格式
- 提取弹幕时间、模式、字号、颜色、内容等字段
- 按时间戳排序后应用密度过滤和时间偏移

### 弹幕渲染
- 使用 `requestAnimationFrame` 实现 60fps 流畅动画
- 轨道碰撞检测，避免弹幕重叠
- 每帧最多渲染 15 条弹幕，防止性能卡顿
- 使用 `will-change` CSS 属性启用 GPU 加速
- 文字阴影增强视频上的可读性
- 仅活跃弹幕元素存在于 DOM 中，自动回收

### 标题匹配算法
- 清洗标题：移除括号、标签、特殊字符
- 繁体→简体中文转换（通过 OpenCC）
- 基于 Jaccard 相似度的词级 + 字符级双重匹配
- 匹配阈值 ≥ 30% 展示，≥ 80% 自动加载

### 状态管理与稳定性
- 使用 `MutationObserver` 监听 YouTube SPA 页面导航
- 加载版本号机制，防止旧请求覆盖新视频弹幕
- 视频播放、暂停、跳转事件同步弹幕状态
- `chrome.storage.local` 持久化 UP主映射与用户设置

---

## 🔒 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 存储 UP主映射和用户设置 |
| `activeTab` | 获取当前标签页信息 |
| `scripting` | 注入弹幕脚本到 YouTube 页面 |
| `youtube.com` | 在 YouTube 页面上运行内容脚本 |
| `api.bilibili.com` | 调用 B站搜索与视频信息 API |
| `comment.bilibili.com` | 获取弹幕数据 |

---

## 📝 开发计划

- [ ] 支持 B站分 P 视频选择
- [ ] 添加弹幕屏蔽词功能
- [ ] 支持导出/导入 UP主映射配置
- [ ] 添加弹幕发送时间显示
- [ ] 支持更多视频平台

---

## 📄 许可证

MIT License

---

## 🙏 致谢

感谢 Bilibili 开放的 API 接口，让这个项目成为可能。

---

<p align="center">
  Made with ❤️ for Bilibili & YouTube users
</p>
