# 部署说明

本项目是纯静态站点，无需构建。仓库根目录即网站根目录：

- 游戏首页：`index.html`
- 训练可视化工具：`visualizer/index.html`

所有资源引用均为相对路径，可直接放在任意子路径下托管。

## 方式一：从分支直接发布（推荐，无需 Actions）

1. 打开仓库 **Settings → Pages**。
2. 在 **Build and deployment** 中，**Source** 选择 **Deploy from a branch**。
3. 分支选 `main`，目录选 `/ (root)`，保存。
4. 访问 `https://<用户名>.github.io/<仓库名>/`。

本项目是纯静态站点，此方式即可完整发布，且每次推送到 `main` 后 Pages 会自动更新。

## 方式二：改用 GitHub Actions 工作流（可选）

仓库根目录提供了 `github-pages.yml.example`（GitHub 的推送保护不允许通过 Personal Access Token 直接创建 `.github/workflows/` 下的文件，因此以示例文件形式提供）。如需改用 Actions 部署：

1. 在仓库网页端手动创建 `.github/workflows/pages.yml`，把 `github-pages.yml.example` 的内容复制进去；或使用具备 `workflow` scope 的 Token 推送该文件。
2. 打开 **Settings → Pages**，将 **Source** 选择为 **GitHub Actions**。
3. 之后每次推送到 `main` 都会触发 `Deploy static site to GitHub Pages` 工作流，也可在 Actions 页手动触发 `workflow_dispatch`。

根目录的 `.nojekyll` 用于避免静态文件被 Jekyll 处理。

## 本地预览

在项目根目录执行：

```bash
python -m http.server 8000
```

浏览器打开：

- 游戏：<http://localhost:8000/>
- 可视化工具：<http://localhost:8000/visualizer/>

也可直接双击 `index.html` 或 `visualizer/index.html` 打开，无需服务器。

## 目录结构

```text
.
├── index.html                  # 游戏首页（网站根入口）
├── styles.css                  # 游戏样式
├── game.js                     # 游戏逻辑
├── visualizer/
│   ├── index.html              # 训练可视化工具入口
│   ├── styles.css
│   └── app.js
├── .nojekyll                   # GitHub Pages 静态文件标记
├── github-pages.yml.example    # Actions 部署工作流示例（可选）
├── README.md
└── DEPLOY.md
```

## 注意事项

- 浏览器需支持现代 Web 标准（Chrome / Edge / Firefox / Safari，含移动版）。
- 项目无外部依赖、无 API 密钥、无后端服务；数据全部在浏览器本地计算。
- 若部署在项目子路径（如 GitHub Pages 的仓库子目录），相对路径仍可正常工作，无需修改配置。
