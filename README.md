# ios-location-spoofer-web

> 📱 基于 Shadowrocket MITM 方案的 iOS GPS 模拟定位 Web 管理面板。  
> 💎 采用 Apple 2026 最新 **Liquid Glass（液态玻璃）** 视觉美学设计，全屏地图选点，支持 100% 独立离线自建托管。

---

## 🌟 核心特性

- 🗺 **四地图瓦片集成**：默认采用全球高清 **国际地图 (CartoDB)** 及 **国际卫星 (Esri Satellite)**，并提供 **高德地图** 与 **高德卫星**，完美满足国内外多场景高精度定位。
- 🎯 **一键对齐与锁定**：固定发光十字准星，滑动地图即时对准。锁定坐标实时写入服务器 `/loc.json`。
- 🎯 **原生 GPS 定位**：右上角控制栏自带定位按钮，点击可一键获取当前物理定位并纠偏对齐。
- 🔒 **全新自建静态托管**：已完整集成 `location-spoofer.js` 劫持脚本和 `ios-location-spoofer.sgmodule` 配置，**不再依赖 GitHub Raw 链接（彻底避免国内网络阻断导致模块失效的问题）**。
- ⭐ **优雅收藏夹**：毛玻璃面板，随时命名并快速保存常用地点，点击一键直达。
- 🔢 **高级参数调节**：底部抽屉拉起可微调海拔高度（地形高度自动拉取接口）、水平精度、垂直精度。
- 🐳 **零依赖极简部署**：后端由 Node.js 原生模块驱动，无任何第三方包依赖，支持 Docker 一键拉起。

---

## 🛠 快速部署

在您的服务器上新建一个空目录，在该目录下只需创建一个 `docker-compose.yml` 文件即可启动运行（无需克隆整个代码仓库）。

### 1. 创建 `docker-compose.yml` 并配置参数

在文件里直接填入您的自定义访问密码（Token）以及高德 Key（可选）：

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
      
      # 1. 网页访问与 Shadowrocket 提取坐标时所使用的安全密码（必填）
      - TOKEN=您的安全密码_Token
      
      # 2. 高德地图 Web 服务 Key（用于高精度国内地名搜索，可选但强烈推荐）
      # 实名认证后可免费申请，若不填国内搜索将回退至慢速的国际 OSM 节点
      - AMAP_KEY=您的高德Web服务Key
```

### 2. 启动容器

在同一目录下运行以下命令（Docker 会自动下载镜像并启动服务）：

```bash
# 第一次启动时（或后续更新版本时），建议先拉取最新镜像
docker compose pull

# 启动容器服务
docker compose up -d
```

启动后，容器服务将在 `8080` 端口监听。

### 2. Nginx 配置 HTTPS 反代
因为 iOS 描述文件和代理连接的安全限制，Shadowrocket 要求域名必需启用 **HTTPS**。配置示例如下：

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

项目已将相关所需文件存放在根目录并开启静态托管，您可以直接通过您的自建服务器进行配置：

### 1. 下载或配置模块文件
- **方案 A（自动）**：直接在手机 Safari 打开 `https://gps.yourdomain.com/ios-location-spoofer.sgmodule`，长按全选复制文本。
- **方案 B（手动）**：在本地复制本项目根目录下的 `ios-location-spoofer.sgmodule` 到手机中。

编辑此模块中的参数以修改域名和密钥（把 `你的域名` 与 `你的Token` 替换为真实信息）：
```ini
[Script]
iOS Location Spoofer = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$,requires-body=1,binary-body-mode=1,max-size=1048576,timeout=10,script-path=https://你的域名/location-spoofer.js,argument=mode=response&configUrl=https://你的域名/loc.json?token=你的Token&latitude=39.90872&longitude=116.39748&horizontalAccuracy=39&verticalAccuracy=1000&altitude=44&debug=false
```

### 2. 导入与运行
1. 将配置好的 `.sgmodule` 导入 Shadowrocket 模块列表中并**启用**它。
2. 前往 Shadowrocket 设置 -> **HTTPS 解密** -> 开启，并**生成/安装/信任 CA 证书**。
3. 启动 Shadowrocket VPN 服务。

---

## 🧭 日常使用流程

1. 手机 Safari 访问：`https://gps.你的域名.com/?token=你的Token`（网页会自动保存登录状态，后续直接打开网页即可）。
2. 在地图上拖动准星对准需要去的目标地点。如果是国内地址，可在上方直接利用高德搜索功能输入地名，定位将秒级飞往目的地。
3. 点击底部的 **「锁定」** 按钮，页面提示已锁定。
4. 在 iPhone 上前往：**设置 -> 隐私与安全 -> 定位服务** -> **关闭**。
5. 等待 2-3 秒后，重新**开启**定位服务。
6. 打开您的地图、微信或其他原生定位应用，此时模拟定位已顺利生效！

---

## ⚖️ 声明与鸣谢

1. **出处与致敬**：本项目中的 iOS 核心数据拦截劫持机制和数据拆封包逻辑全部提取并基于 **[mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer)** 核心脚本 `location-spoofer.js` 二次开发。在此对原作者的开源精神表示衷心感谢！
2. **免责声明**：本项目仅供开发者用于地图开发测试、地理位置接口调试以及技术性学习研究，请勿用于非法用途。因违规使用产生的一切风险与后果由使用者自行承担。

---

## 📄 开源授权

MIT License
