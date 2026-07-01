# ios-location-spoofer-web

> 基于 Shadowrocket MITM 方案的 iOS GPS 欺骗 Web 管理面板。Apple Liquid Glass UI 风格，地图选点，一键锁定位置。

## 功能

- 🗺 **全屏地图选点**：高德矢量 / 高德卫星 / 国际 OSM 三图层，十字准星模式
- 📍 **一键锁定位置**：实时写入服务器，Shadowrocket 自动读取
- ⭐ **收藏夹**：保存常用地点，点击即跳转
- 🔢 **精度参数**：可手动调节海拔、水平精度、垂直精度
- 🔑 **Token 鉴权**：防止他人随意修改你的位置
- 🐳 **零依赖 Docker 部署**：Node.js 内置模块，无需 npm install

## 快速部署

```bash
# 1. 克隆
git clone https://github.com/akudamatata/ios-location-spoofer-web.git
cd ios-location-spoofer-web

# 2. 配置 Token
cp .env.example .env
# 编辑 .env，设置你的 TOKEN

# 3. 启动
docker compose up -d
```

容器监听 `8080` 端口，配合 Nginx 反代到你的 HTTPS 域名即可。

## Nginx 反代示例

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## Shadowrocket 配置

在已有的 `iOS Location Spoofer` 模块参数里，将 `configUrl` 改为：

```
configUrl=https://gps.你的域名.com/loc.json?token=你的Token
```

## 使用流程

1. 手机 Safari 访问 `https://gps.你的域名.com`（自动带 Token）
2. 拖动地图，十字准星对准目标位置
3. 点底部「锁定」按钮
4. 去手机 **设置 → 隐私 → 定位服务 → 关掉再开**
5. 定位生效 ✅

## 为什么需要重开定位

iOS 的定位数据有缓存。Shadowrocket 脚本是在 iOS 向苹果服务器请求定位时才触发，重开定位服务会强制 iOS 重新发请求，此时脚本拉到新坐标并注入，定位生效。

## 参考项目

- [mekos2772/ios-location-spoofer](https://github.com/mekos2772/ios-location-spoofer) - 核心 MITM 脚本

## License

MIT
