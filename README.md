# ios-location-spoofer-web

> 📱 基于 Shadowrocket MITM 方案的 iOS GPS 模拟定位 Web 管理面板。  
> 💎 采用 Apple 2026 最新 **Liquid Glass（液态玻璃）** 视觉美学设计，全屏地图选点，支持 100% 独立离线自建托管。

---

## 🌟 核心特性

- 🗺 **四地图瓦片集成**：默认采用全球高清 **国际地图 (CartoDB)** 及 **国际卫星 (Esri Satellite)**，并提供 **高德地图** 与 **高德卫星**，完美满足国内外多场景高精度定位。
- 🎯 **一键对齐与锁定**：固定发光十字准星，滑动地图即时对准。锁定坐标实时写入服务器 `/loc.json`。
- 🎯 **原生 GPS 定位**：右上角控制栏自带定位按钮，点击可一键获取当前物理定位并纠偏对齐。
- 🔒 **完全自建托管**：已完整集成 `location-spoofer.js` 劫持脚本和 `ios-location-spoofer.sgmodule` 配置，**不再依赖 GitHub Raw 链接，彻底避免国内网络阻断导致模块失效的问题**。
- ⭐ **优雅收藏夹**：毛玻璃面板，随时命名并快速保存常用地点，点击一键直达。
- 🔢 **高级参数调节**：底部抽屉拉起可微调海拔高度（地形高度自动拉取接口）、水平精度、垂直精度。
- 🐳 **零依赖极简部署**：后端由 Node.js 原生模块驱动，无任何第三方包依赖，支持 Docker 一键拉起。

---

## 🛠 快速部署

在您的服务器上新建一个空目录，创建一个 `docker-compose.yml` 文件即可启动（**无需克隆整个代码仓库**）。

### 1. 创建 `docker-compose.yml`

将以下内容复制粘贴，填入您的 Token 和高德 Key：

```yaml
services:
  gps-spoofer:
    image: ghcr.io/akudamatata/ios-location-spoofer-web:latest
    container_name: gps-spoofer
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      - PORT=8080
      - DATA_DIR=/data

      # 网页访问与 Shadowrocket 提取坐标时所使用的安全密码（必填）
      - TOKEN=您的安全密码

      # 高德地图 Web 服务 Key（用于高精度国内地名搜索，可选但强烈推荐）
      - AMAP_KEY=您的高德WebServiceKey
```

### 2. 启动容器

```bash
# 拉取最新镜像并启动
docker compose pull
docker compose up -d
```

启动后服务监听在 `8080` 端口。

### 3. 配置 Nginx HTTPS 反代

Shadowrocket 要求 HTTPS，配置示例：

```nginx
server {
    listen 80;
    server_name gps.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name gps.yourdomain.com;

    ssl_certificate /path/to/your/cert.crt;
    ssl_certificate_key /path/to/your/cert.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 📲 Shadowrocket 配置指南

### 1. 导入配置文件

1. 在手机浏览器打开面板（首次需带 token）：
   ```
   https://gps.yourdomain.com/?token=您的Token
   ```
2. 点击页面右上角 **「⚙️ 设置」** 图标，复制**订阅链接**
3. 打开 Shadowrocket → 底部 **「配置」** 标签页 → 右上角 **「+」**
4. 粘贴订阅链接 → 点击**下载**，即可获取配置文件
5. 点击下载好的配置文件 → **「使用配置」** 将其设为当前生效配置

### 2. 开启 HTTPS 解密与安装证书

点击当前配置文件进入详情 → **「HTTPS 解密」**：

1. 开启 **「HTTPS 解密」** 开关
2. 开启 **「通过 HTTP/2 进行中间人攻击 (MitM)」** 开关
3. 点击 **「证书」** → **「生成新的 CA 证书」** → **「安装证书」**
4. 前往 iPhone **「设置 → 通用 → 关于本机 → 证书信任设置」**，找到 Shadowrocket 证书并**完全信任**

### 3. 启动 VPN

回到小火箭首页，开启 VPN 开关，模式保持 **「配置 (Config)」** 即可。

---

## 🧭 日常使用流程

1. **打开面板**：手机浏览器访问 `https://gps.yourdomain.com`（首次需带 `?token=xxx`，之后自动保存 30 天免登录）
2. **选点**：地图上拖动准星，或顶部搜索框输入地名（国内地址推荐高德地图模式）
3. **锁定**：点击 **「锁定」** 按钮，页面提示"位置已锁定"
4. **刷新定位**：前往 iPhone **「设置 → 隐私与安全 → 定位服务」**，关闭后等 2-3 秒再重新开启
5. **验证**：打开高德地图、微信或系统地图，此时模拟定位已顺利生效 ✅

> **换位置**：重复步骤 2-4 即可，无需重启小火箭。

---

## ⚖️ 声明与鸣谢

1. **出处与致敬**：本项目中的 iOS 核心数据拦截劫持机制和数据拆封包逻辑全部基于 **[mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer)** 的核心脚本 `location-spoofer.js`，在此对原作者的开源精神表示衷心感谢！
2. **免责声明**：本项目仅供开发者用于地图开发测试、地理位置接口调试以及技术性学习研究，请勿用于非法用途。因违规使用产生的一切风险与后果由使用者自行承担。

---

## 📄 开源授权

MIT License
