# GitHub 上传说明

这个文件夹已经是可直接提交的仓库根目录：

```
dsh-skill-manager/
├── .gitattributes        换行符归一化（全部 LF）
├── .gitignore            忽略 node_modules、日志、运行时状态
├── .npmignore            npm 发布时的额外排除
├── CHANGELOG.md          变更记录（Keep a Changelog 格式）
├── LICENSE               MIT
├── README.md             主文档（中文）
├── README.en.md          英文文档
├── client.js             Client 半边：设置页面板
├── cordis.patch.yml      bundle 补丁（loader id = skill-manager）
├── dsh.plugin.json       插件清单（id = skill-manager）
├── icon.svg              插件图标
├── index.js              Host 半边：扫描 / 屏蔽 / 指令 / 管理路由
├── locale/
│   ├── en.json
│   └── zh.json
└── package.json          npm 元数据 + dsh 清单
```

## 上传前的三步

1. **补上仓库地址**（可选但推荐）。在 `package.json` 里加入：

   ```json
   "repository": { "type": "git", "url": "git+https://github.com/<你的账号>/dsh-skill-manager.git" },
   "homepage": "https://github.com/<你的账号>/dsh-skill-manager#readme",
   "bugs": { "url": "https://github.com/<你的账号>/dsh-skill-manager/issues" },
   "author": "<你的名字>"
   ```

2. **建仓并推送**（当前机器没有安装 git，需在装有 git 的环境执行）：

   ```bash
   cd dsh-skill-manager
   git init -b main
   git add .
   git commit -m "feat: initial release of dsh-skill-manager v1.0.0"
   git remote add origin git@github.com:<你的账号>/dsh-skill-manager.git
   git push -u origin main
   ```

3. **（可选）发布到 npm**：`npm publish`。不想发布就保持现状，用户用
   `dsh plugin add "github:<你的账号>/dsh-skill-manager"` 安装即可。

## 本地自检

```bash
npm run check      # node --check index.js && node --check client.js
npm run pack:dry   # 预览 npm 会打包哪些文件
```

两半都是可直接加载的 JavaScript，不需要构建步骤，因此仓库里没有 `src/`、
没有 `dist/`、也没有测试脚手架。
