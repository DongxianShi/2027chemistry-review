# GitHub Pages 发布说明

这个网站不需要上传原始 PDF。页面运行依赖的是已经抽取好的静态缓存：

- `index.html`
- `styles.css`
- `app.js`
- `network_data.js`
- `build/page_images/`
- `build/page_images_hd/`（高清页图，网页会优先使用；缺失时回退到 `build/page_images/`）

`chemistry_method.pdf` 体积约 610MB，已在 `.gitignore` 中排除。原页查看功能会打开页面截图，不会请求 PDF。

如果公开站点中原页打不开，请确认 `build/page_images/` 与 `build/page_images_hd/` 已上传；如果例题打不开，请确认 `network_data.js` 已上传到同一目录。

## 本地自动同步

首次同步或手动同步：

```powershell
.\tools\sync_github_pages.ps1 -RepoDir ..\2027chemistry-review-sync
```

持续监听本地改动并自动提交推送：

```powershell
.\tools\sync_github_pages.ps1 -RepoDir ..\2027chemistry-review-sync -Watch
```

说明：脚本会同步网页文件、`network_data.js`、`build/page_images/` 和 `build/page_images_hd/`，不会上传 PDF。GitHub Pages 从推送到公开站点刷新通常仍会有几十秒延迟。

如需重新生成高清页图：

```powershell
npm install pdfjs-dist@5.7.284 --no-save
$env:HD_SCALE='2'; $env:HD_QUALITY='0.86'; node .\tools\render_hd_pages.mjs
```
