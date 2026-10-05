# Count–Min Sketch 频次估计后端

一个 Windows 本地可运行的 Count–Min Sketch（CMS）近似频次查询服务，仅提供 **HTTP API 与 CLI**，
使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无 Docker、无外部服务）。

## 功能概述

- 面向**非负加权事件流**：对字符串键累计正整数权重，支持单笔与批量增加。
- 固定大小计数矩阵 `d × w`（`1 ≤ d ≤ 8`，`1 ≤ w ≤ 4096`），每行用独立哈希把键映射到列，
  增加时把权重加到各行对应单元，查询取各行单元的**最小值**。
- 只实现**标准更新**：不做 conservative update、不支持负权重与删除。
- 计数与总权重使用 **BigInt 精确整数**，JSON 中以十进制字符串传输，
  超过 `Number.MAX_SAFE_INTEGER` 也不丢精度。
- 两个**参数兼容**（宽度、深度、种子相同）的摘要可合并为**新的快照**，来源不被修改；
  合并是逐单元相加（不是集合并集），相同键权重相加，自合并会翻倍。
- 支持创建、增加、查询、碰撞解释、查看单元、合并、导出/导入状态、操作历史。
- SQLite 原子持久化：非法批次不会留下部分更新；重启后继续操作与同顺序不间断运行结果一致。

## 哈希规则（确定性的，版本化）

```
column = SHA256( seed:uint32 BE || row:uint32 BE || utf8(key) )[0..8) 作为无符号大端整数 mod w
```

- 版本字符串形如 `cms1:w{width}:d{depth}:s{seed}:utf8`，包含宽度、深度、种子与编码。
- 键**区分大小写**，不做 trim、不做 Unicode 归一化；空字符串是合法键；拒绝非法 Unicode（孤立代理项）。
- `explain` 返回每行的列下标、该单元计数，以及决定最小值的行。

## 估计性质与限制

- 在没有负更新的前提下，估计值**不低于**真实频次（只会因碰撞偏高）。
- **不能**保证每次误差都小于某个固定百分比；未出现过的键也可能因碰撞得到正值，
  因此不能用它判断成员存在性。
- 本服务**只回答单键频次**：不估计不同键数量、不做成员判断、不返回热门键列表。
- Sketch 不保存原始键，**无法列出所有键**；精确字典仅在演示/测试中作为独立基准使用。
- 空间上限固定：`d × w ≤ 8 × 4096 = 32768` 个单元，与键的数量无关。

## 碰撞解释示例

宽度为 1 时所有键都落入同一列，估计值等于总权重（`npm run demo` 实际输出）：

```
width= 1 depth=4 estimates: apple=25(+17) banana=25(+21) cherry=25(+18) ...
width= 4 depth=4 estimates: apple=8(+0)  banana=4(+0)  cherry=9(+2)  ...
width=64 depth=4 estimates: apple=8(+0)  banana=4(+0)  cherry=7(+0)  ...
```

增大宽度通常会降低高估，但**不保证**对每个键、每个数据集都单调下降。

## 快速开始

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口）
npm start -- --port 8080        # 指定端口；也可用环境变量 PORT
npm run demo       # 碰撞演示（width=1 vs 更宽矩阵）
```

数据目录默认为项目内 `./data`，可用环境变量 `CMS_DATA_DIR` 覆盖。

## HTTP API

所有响应均为 JSON；错误格式为 `{"error":{"code":"...","message":"..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 服务信息与公开上限 |
| POST | `/sketches` | 创建 `{width, depth, seed?}` |
| GET | `/sketches` | 列出全部摘要 |
| GET | `/sketches/:id` | 摘要元信息 |
| POST | `/sketches/:id/add` | 单笔 `{key, weight}` 或批量 `{items:[...]}` |
| GET | `/sketches/:id/query?key=K` | 查询单键估计频次 |
| POST | `/sketches/:id/query` | 批量查询 `{keys:[...]}` |
| GET | `/sketches/:id/explain?key=K` | 每行下标、计数与最小值位置 |
| GET | `/sketches/:id/cells?row=R&offset=N&limit=M` | 查看有限单元（limit ≤ 512） |
| POST | `/sketches/:id/merge` | `{otherId}`，生成新的合并快照 |
| GET | `/sketches/:id/export` | 导出完整状态 JSON |
| POST | `/import` | 导入状态（校验维度、非负计数、每行和等于总权重） |
| GET | `/sketches/:id/history?limit=N` | 操作历史 |

**公开上限**：请求体 ≤ 1 MiB；单批增加/查询 ≤ 1000 条；键 ≤ 4096 UTF-8 字节。

**错误码**：`INVALID_PARAM`、`INVALID_KEY`、`INVALID_WEIGHT`、`INVALID_JSON`、
`INVALID_STATE`、`INCOMPATIBLE_MERGE`、`NOT_FOUND`、`LIMIT_EXCEEDED`、`INTERNAL`。

示例：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8080/sketches -ContentType 'application/json' -Body '{"width":1024,"depth":4,"seed":42}'
Invoke-RestMethod -Method Post http://127.0.0.1:8080/sketches/1/add -ContentType 'application/json' -Body '{"items":[{"key":"apple","weight":"5"}]}'
Invoke-RestMethod 'http://127.0.0.1:8080/sketches/1/explain?key=apple'
```

## CLI

CLI 直接操作同一数据目录（`CMS_DATA_DIR`），与 API 共享存储格式：

```powershell
npm run cli -- create --width 1024 --depth 4 --seed 42
npm run cli -- add 1 --key apple --weight 5
npm run cli -- add-batch 1 --file items.json
npm run cli -- query 1 --key apple
npm run cli -- explain 1 --key apple
npm run cli -- cells 1 --row 0 --offset 0 --limit 16
npm run cli -- merge 1 2
npm run cli -- export 1 --file state.json
npm run cli -- import --file state.json
npm run cli -- history 1 --limit 20
npm run cli -- list
```

## 项目结构

```
src/hash.ts    确定性列下标（SHA-256，大端种子+行号前缀）
src/sketch.ts  Count–Min Sketch 核心（BigInt 矩阵、合并、导入校验）
src/store.ts   SQLite 持久化（事务、历史、导入导出）
src/server.ts  HTTP API（可配置端口，默认 0 = 自动空闲端口）
src/cli.ts     命令行入口
src/demo.ts    宽度与碰撞演示
test/          node:test 测试（哈希向量、大整数、空键、合并性质、重启一致性等）
```

## 测试覆盖

固定哈希输入的列下标（含黄金值）、BigInt 大权重、空键与大小写敏感、非法 Unicode 拒绝、
权重叠加、导入拒绝（维度/负计数/行和/版本）、随机小样本对独立精确字典的高估性质、
合并的交换律/结合律/自合并翻倍/与连续增加一致、快照隔离、非法批次原子性、重启后查询一致。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`；开发验证于 Node 25）。
- 不需要 Docker / WSL / 付费服务 / 外部 API。
- 注意：`node:sqlite` 在部分 Node 版本会打印 ExperimentalWarning，不影响功能。
