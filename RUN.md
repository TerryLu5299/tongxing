# 本机运行（原生，无 Docker）

## 地址与端口

- 网页：http://localhost:3000（后台 http://localhost:3000/admin，登录名 admin，密码存于 .env 的 ADMIN_PASSWORD）
- API：http://127.0.0.1:3001（健康检查 /api/health）
- 数据库：PostgreSQL 17，服务名 PostgreSQL17，程序装 D:\PostgreSQL\17，数据在 E:\pgdata，库名 myhot，密码存于 .env
- 模型：本机 http://127.0.0.1:8082/v1（qwen3.8-flash-next-sc117-iq3-xxs，零费用）

## 启动

仓库根目录 `E:\projects\同行`，三个进程都要带 `NODE_ENV=production`：

```bash
cd E:/projects/同行
NODE_ENV=production node --env-file=.env apps/api/src/main.ts        # API，3001
NODE_ENV=production node --env-file=.env apps/worker/src/main.ts     # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts  # 网页，3000
```

停止 worker 时给它至少 210 秒收尾进行中的付费调用（Ctrl+C 后等它自己退，别强杀）。

## 停止

各进程窗口 Ctrl+C（worker 等 ≥210 秒）。数据库是 Windows 服务：`net stop PostgreSQL17`（重启用 `net start PostgreSQL17`）。

## 常用命令（仓库根目录）

```bash
npm run db:migrate                      # 迁移
node --env-file=.env scripts/seed.ts   # 种子
npm run build -w @tongxing/web            # 改了 web 后重新构建
node --env-file=.env scripts/smoke.ts --base http://localhost:3000   # 冒烟
node --env-file=.env scripts/collect.ts <source-id>                  # 手动采一个信源
```

## 说明

- 开发模式（热更新）：`npm run dev:api` / `dev:worker` / `dev:web`，免登录后台在 .env 设 `DEV_AUTH_ROLE=admin`（生产模式拒绝启动）。
- 采集/模型安全阀：.env 里 `COLLECT_ENABLED` / `MODEL_CALLS_ENABLED`，写成 true 才开。
- 密钥全部在 .env（不入库），本文件不写明文。
