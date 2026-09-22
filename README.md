# Facet SDK

TypeScript / Node.js 本地数据分析 SDK。将 API 结果存入 SQLite，为 agent 提供 schema、说明和只读 SQL 工具。无运行时 npm 依赖，不启动 HTTP 服务，不连接远端存储，不调用模型。

## 安装

需要 Node.js >= 24.10，使用内置 `node:sqlite`。适用于 Node 服务或桌面应用的 Node 主进程，不适用于浏览器。

```sh
npm install /path/to/local-facet-0.5.0.tgz
```

包名 `@local/facet`，未发布 npm。源码目录运行 `npm install && npm test`，`npm pack` 生成安装包。

## 接入

```ts
import { Facet } from '@local/facet';

const sdk = Facet.open({
  directory: './local-data/customer-001',
  query: { maxRows: 1000, timeoutMs: 5000 },
});
try {
  const response = { data: [{ id: 'o1', supplier: 'A', amount: 10000 }] };
  sdk.datasets.fromResponse(response, {
    table: 'orders',
    select: result => result.data,
    primaryKey: ['id'],
    mode: 'upsert',
    description: '采购订单',
    grain: '一行一张订单',
    columns: { amount: { type: 'INTEGER', description: '含税金额', unit: 'CNY cent' } },
    source: { name: 'orders_api', completeness: 'complete', filters: { year: 2026 } },
  });

  const instructions = sdk.agent.instructions();
  const tools = sdk.agent.tools();
  // instructions 传入 agent 指令；tools 转为你们框架的工具格式。
  // 每项包含 name / description / inputSchema / execute(input)。

  console.log(await sdk.query(
    'SELECT supplier, sum(amount) AS total FROM orders WHERE amount > ? GROUP BY supplier', [0],
  ));
} finally {
  await sdk.close();
}
```

## 本地存储

目录自动创建，路径相对于当前工作目录。数据、schema、关系、范围和版本全部保存为 `directory/data.sqlite`，运行期间可能存在 `data.sqlite-wal` 和 `data.sqlite-shm`。同一目录重新 open 即可恢复数据。每个目录是独立工作空间，由业务系统把租户映射到可信路径。

`directory` 和 `databasePath` 暴露实际绝对路径。SDK 不上传数据、不采集遥测；宿主自行决定哪些结果传给模型。本地文件未加密。

## 公共接口

| 接口 | 用途 |
| --- | --- |
| `Facet.open({ directory, query? })` | 打开本地工作空间和默认查询预算 |
| `sdk.datasets.write(options)` | 直接导入 records 数组 |
| `sdk.datasets.fromResponse(response, options)` | 通过 select 提取 API 记录并导入 |
| `sdk.datasets.list()` | 查看数据目录 |
| `sdk.datasets.describe(name)` | 查看 schema、口径、范围、关系和版本 |
| `sdk.relations.add(relation)` | 声明表间关系 |
| `sdk.query(sql, params?, options?)` | 参数化只读查询 |
| `sdk.agent.instructions()` | 生成 agent 使用说明 |
| `sdk.agent.tools()` | 生成框架无关工具 |
| `await sdk.close()` | 拒绝新操作，等待在途查询结束并关闭 |

支持 `await using sdk = Facet.open(...)`。重复 close 安全。关闭后的数据操作抛 `FacetError`（code=CLOSED），查询和 agent 工具返回结构化 CLOSED 错误。初始化配置/存储错误使用 FacetError，底层写入/校验错误会抛出，调用方应捕获。保留旧 DataWorkspace 低层接口兼容，新接入使用 Facet。

## 写入与 schema

- `append`：默认插入，重复主键报错。
- `upsert`：需要主键，只更新记录中出现的字段；省略保留原值，显式 null 清空。
- `replace`：事务内清空再写入，保留已有 schema。

数据及元数据事务一致，失败全部回滚。新增字段自动加列，已有列类型/主键变化需新建数据集。空数组结合明确 columns 可创建空表。

类型支持 TEXT/INTEGER/REAL/BOOLEAN/JSON，默认推断；全空列需指定类型，混合类型默认拒绝。嵌套对象/数组转 JSON 文本，不自动拆表。日期请规范成 ISO-8601 字符串。布尔值存为 0/1。INTEGER 接收 JS 安全整数，大整数 ID 应传字符串；精确金额建议使用整数分。查询超出安全范围的整数返回十进制字符串。

表/字段名须英文字母开头，后续可含数字和下划线，中文说明放 description。SDK 不猜业务含义。

```ts
sdk.relations.add({
  from: { table: 'orders', column: 'supplier_id' },
  to: { table: 'suppliers', column: 'id' },
  cardinality: 'many_to_one',
});
```

关系只检查字段存在，不强制外键或校验基数。

## API 分页与范围

调用方负责 HTTP、鉴权、分页和重试，SDK 接收返回对象。source 描述整张本地表，不是当前页。complete 表示 filters 范围内完整，不表示上游全量；其他状态为 partial/sampled/unknown。

分页期间标 partial，全部成功后再标 complete（可使用空 records 更新元数据）。写入未传 source 时重置为 unknown，避免复用失效承诺。切换范围应 replace 或新建表。SDK 不验证上游完整性或 filters 与数据是否一致。

## Agent 工具和查询

提供 list_datasets、describe_dataset、query。默认查询预算同时应用于 query 工具。

```ts
const tool = sdk.agent.tools().find(t => t.name === 'query')!;
const result = await tool.execute({ sql: 'SELECT count(*) AS n FROM orders' });
```

成功返回 `{ ok: true, columns, rows, returnedRows, truncated, dataVersions, elapsedMs, schemaVersion }`，失败返回 `{ ok: false, error: { code, message, hint? } }`。dataVersions 对应读取快照，表达式列类型可能为 null。

只接受不带末尾分号的单条 SELECT/WITH。子查询包装可能重命名重复列，建议显式别名。默认 1000 行、约 1 MiB 行 JSON、5 秒；硬上限 10000 行、10 MiB、30 秒。truncated 不表示总行数，统计总数应执行 COUNT。

独立本地子进程通过只读连接查询，authorizer 限制只访问已登记数据表，拒绝内部表、PRAGMA、ATTACH、写入和扩展加载。超时 SIGKILL 终止子进程。没有 OS 级 CPU/内存配额、行级权限，宿主需限制并发并隔离租户。

## 开发与部署

```sh
npm install
npm test
npm run example
npm pack
```

测试覆盖 10 万行聚合、API 导入、重开、更新、回滚、关系、查询限制、参数绑定、JSON、截断、超时、关闭及 agent 调用。未验证具体模型的分析正确率。

写入为同步批量事务，较大批次可由宿主放后台 worker；查询每次启动子进程。部署请保留 dist 内的查询进程文件，使用 bundler 时将此包设为 external。

实现依据：[Node SQLite API](https://nodejs.org/api/sqlite.html)。

## CLI（与 SDK 共用本地数据）

安装 0.5.0 包后，项目内使用 `npx --no-install facet`；全局安装时可直接运行 `facet`。下面命令用简写形式展示。CLI 不启动服务器。

```sh
facet workspace init --directory ./local-data
facet dataset import --directory ./local-data --table orders --file response.json --select data.items --key id
facet tables --directory ./local-data
facet schema orders --directory ./local-data --jsonl
facet sql --directory ./local-data 'SELECT supplier, sum(amount) AS total FROM orders GROUP BY supplier'
facet agent guide --directory ./local-data
facet workspace verify --directory ./local-data
```

`--file -` 从 stdin 读取；`--format jsonl` 导入逐行记录；`--select data.items` 提取 JSON API envelope。默认 upsert，首次建表须 `--key id`（复合键用逗号）；明确追加或替换使用 `--mode append|replace`。业务元数据通过 `--metadata metadata.json` 导入，可包含 description、grain、columns、source。

默认 TSV，`--jsonl` 返回逐行 JSON。查询默认 20 行，可用 `--max-rows` 调整（最多 10000），`--timeout-ms` 设置预算。`--sql-file` 可代替 `--sql`，`--params '[2026]'` 绑定参数，`--out result.jsonl` 将结果存文件（拒绝覆盖）。结果包含截断标记，不能把返回行数当作总行数。

`facet describe` / `--help` 展示命令，`agent tools` 返回 SDK 工具定义，`relation add --file relation.json` 声明关系。`workspace verify` 校验目录所声明的字段可查询，不替代 SQLite 完整性检查。

退出码：0 成功、2 参数/SQL 错误、4 不存在、5 冲突、9 超时/存储故障。错误只写 stderr，数据只写 stdout。除 workspace init 外，不会自动创建不存在的工作空间。默认目录 `.facet`，建议显式指定。SDK 与 CLI 的 schema/查询实现共用，已写数据互通。

给 agent 的命令行操作说明见随包的 `SKILL.md`。

## 0.4 命名更新

CLI 为 `facet`，包名为 `@local/facet`，SDK 入口为 `Facet`。默认目录改为 `.facet`；已有数据无需转换，传 `--directory` 或 SDK 的 directory 指向原目录即可。CLI 输出 schema 标识为 `facet.cli.v1`。

## 简洁的 Agent 入口

业务代码通过 SDK 写入，agent 只需要三个命令：

```sh
facet tables
facet schema
facet schema orders
facet sql 'SELECT * FROM orders'
```

默认读取 `.facet/data.sqlite`；显式指定 `--directory ./data` 可读取 SDK 写入的目录。schema 不带表名时展示所有表，带表名时展示该表字段、类型、主键、业务说明、数据范围和关联关系。`--jsonl` 返回完整机器可读元数据。旧命令保留兼容，不作为主要接入方式。

## 从 GitHub 开发

```sh
git clone https://github.com/apeironlab/facet.git
cd facet
npm ci
npm test
npm pack
```

生成的 tgz 可安装到业务项目中；包尚未发布 npm。
