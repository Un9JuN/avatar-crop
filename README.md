# 图标（PWA / 应用）

这里就是以后美化图标的“地基”，换图标**不需要改代码、不需要改 manifest**，只要用同名文件覆盖即可。

## 当前文件

| 文件 | 用途 | 要求 |
|---|---|---|
| `icon-192.png` | Android / PWA 常规图标 | 192×192，圆角已内置 |
| `icon-512.png` | PWA 常规大图标、启动画面 | 512×512，圆角已内置 |
| `icon-maskable-512.png` | Android 自适应图标（安全区） | 512×512，满幅背景，主体缩到中间约 72% |
| `apple-touch-icon-180.png` | iOS 添加到主屏 | 180×180，不加圆角（系统自己裁） |
| `favicon-32.png` | 浏览器标签图标 | 32×32 |

## 以后怎么换

1. 设计稿导出上面 5 个尺寸（命名保持一致）；
2. 直接覆盖本目录文件；
3. 如果改了 `manifest.webmanifest` 里的名字/主题色，记得同步 `theme-color` 和 `background_color`；
4. 改了任何被 Service Worker 缓存的资源，把 `sw.js` 里的 `VERSION` 加一，避免用户看到旧图标。

## 重新生成

当前图标是脚本画的（暖炭黑底 + 骨白裁切角 + 安全灯琥珀圆环，和界面同一套语言）：

```bash
python tools/make_icons.py
```

想调整配色/图形，改 `tools/make_icons.py` 顶部的 `INK / WARM / BONE / AMBER` 和 `glyph()` 参数即可。
矢量源文件在 `icon.svg`，以后有正式设计稿，直接替换 PNG，脚本可以废弃。
