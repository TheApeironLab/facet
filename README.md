# Facet

本地 TypeScript SDK + SQL CLI。业务代码通过 SDK 写入 API 数据，agent 通过标准 SQLite SQL 分析。数据和元数据保存在同一个本地 SQLite 文件，无 HTTP 服务、远端存储或模型依赖。

## 安装

需要 Node.js >=24.10，ESM。包名 `@local/facet`，尚未发布 npm。

```sh
git clone https://github.com/TheApeironLab/facet.git
cd facet
npm ci
npm test
npm pack
# 在业务项目中安装生成的包
npm install /path/to/local-facet-0.6.0.tgz
```

项目内使用 `npx --no-install facet`，全局安装后可直接运行 `facet`；源码目录先 build，再运行 `node dist/cli.js`。

## SDK 写入

```ts
import { Facet } from '@local/facet';

const facet = Facet.open({ directory: './data' });
try {
  const response = { items: [{ id: 'o1', supplier: 'A', amount: 10000 }] };
  facet.write({
    table: 'orders',
    records: response.items,
    primaryKey: ['id'],
    mode: 'upsert',
    description: '采购订单',
    grain: '一行一张订单',
    columns: { amount: { type: 'INTEGER', unit: 'CNY cent' } },
    source: { completeness: 'complete', filters: { year: 2026 } },
  });
} finally {
  await facet.close();
}
```

也可以通过 `facet.writeResponse(response, { table, select: r => r.items, ... })` 提取 API 返回记录。调用方负责 HTTP、鉴权、分页和重试。

## SDK 和 CLI 统一命名

| 能力 | SDK | CLI |
| --- | --- | --- |
| 列出表 | `facet.tables()` | `facet tables` |
| 所有表结构 | `facet.schema()` | `facet schema` |
| 指定表结构 | `facet.schema('orders')` | `facet schema orders` |
| SQL 分析 | `await facet.sql('SELECT ...', params?)` | `facet sql 'SELECT ...'` |

```sh
facet tables --directory ./data
facet schema orders --directory ./data
facet sql 'SELECT supplier, SUM(amount) AS total FROM orders GROUP BY supplier' --directory ./data
facet sql 'SELECT * FROM orders WHERE amount > ?' --params '[100]' --directory ./data
```

`tables()` 返回 name、description、rowCount 和 source。`schema()` 返回所有表的完整结构数组，`schema(name)` 返回单表结构，包括字段、主键、业务含义、粒度、来源范围、版本和关系。CLI 使用相同 SDK 实现。

其他 SDK 方法：`write`、`writeResponse`、`relate`、`instructions`、`tools`、`close`。`relate({ from: { table, column }, to: { table, column }, cardinality })` 声明关系，检查字段存在但不执行外键/基数校验。

可选 `facet.tools()` 返回名称为 tables/schema/sql 的三个工具，各含 name、description、inputSchema、execute。schema 工具参数为 `{ table?: string }`，sql 工具参数为 `{ sql, params? }`。使用 CLI 的 agent 不需要接这些工具。`facet.instructions()` 提供分析原则；仓库使用和维护指南见 [AGENTS.md](./AGENTS.md)。

## 本地存储与生命周期

SDK 显式传 directory，CLI 默认 `.facet`。两者必须指向同一目录，该目录包含 `data.sqlite` 以及运行期间可能存在的 WAL/SHM 文件。一个数据库可有多张表。SDK 自动创建目录，CLI 遇到不存在的数据库报错，不会自动创建。

重复打开同一目录可恢复数据。`await facet.close()` 停止接受新操作，等待在途查询后关闭；支持重复 close 和 `await using`。关闭后写入/元数据读取抛 FacetError，SQL/工具返回结构化错误。初始化错误使用 FacetError，写入校验和 SQLite 错误可能直接抛出。

不上传数据、不采集遥测；本地文件未加密。调用方负责租户目录权限及发给模型的内容。

## 写入规则

- 默认 append：插入，重复主键报错。
- upsert：需要主键；省略字段保持原值，显式 null 清空。
- replace：事务内清空后写入，保留已有 schema。

写入及元数据更新在同一事务中，失败回滚。允许新增列，不允许原列类型或主键变化。空数组可结合 columns 创建空表。

类型为 TEXT/INTEGER/REAL/BOOLEAN/JSON；可自动推断，全空列需指定类型，混合类型默认拒绝。对象和数组存 JSON 文本；日期请规范为 ISO-8601 字符串；BOOLEAN 存 0/1。输入整数须为 JS 安全整数，大整数 ID 用字符串，精确金额建议用整数分。查询超出 JS 安全范围的整数返回十进制字符串。

表/列名需英文字母开头，后续为字母、数字或下划线；业务中文名放 description。

source 描述整张表：complete 表示 filters 范围内完整，其他状态为 partial/sampled/unknown。分页期间用 partial，全部完成再声明 complete。写入省略 source 会重置为 unknown。切换范围应 replace 或新建表；库不验证实际完整性。

## SQL 约定

SQL 仅接受单条 SELECT/WITH，不带末尾分号，参数使用 `?`。CLI 支持 `--sql-file FILE`（`-` 为 stdin）代替位置参数。默认输出 TSV，`--jsonl` 输出版本化 JSONL；`--out FILE` 导出 JSONL，拒绝覆盖已有文件。

SDK、工具和 CLI 默认均为 20 行、约 1 MiB 行 JSON、5 秒；最大 10000 行、10 MiB、30 秒。SDK 用 `Facet.open({ directory, sql: { maxRows, timeoutMs } })` 配置默认值，或通过 `sql` 第三个参数覆盖。CLI 用 `--max-rows` 和 `--timeout-ms`。

成功返回 `{ ok, columns, rows, returnedRows, truncated, dataVersions, elapsedMs, schemaVersion }`，失败返回 `{ ok: false, error: { code, message, hint? } }`。truncated 不表示总数，统计总数执行 COUNT。计算列类型可能为 null，重复列名可能由 SQLite 重命名，建议显式别名。

CLI JSONL schema 标识为 facet.cli.v2，schema 命令元数据使用 table 字段。退出码：0 成功、2 参数/SQL 错误、4 不存在、5 冲突、9 超时/存储故障。数据写 stdout，错误写 stderr。

查询使用独立子进程、只读连接和 authorizer，拒绝写入、内部表、PRAGMA、ATTACH 和扩展加载。超时终止子进程；未实现 OS 内存/CPU 配额或行级权限，宿主需限制并发。写入是同步事务，大批次可由宿主放后台执行。部署需保留 dist 下查询进程文件，bundler 应将本包 external。

## 0.6 迁移

这次统一接口是破坏性更新，不保留旧别名：

| 旧接口 | 新接口 |
| --- | --- |
| `datasets.write` / `datasets.fromResponse` | `write` / `writeResponse` |
| `datasets.list` / `datasets.describe` | `tables` / `schema` |
| `query` / 初始化配置 `query` | `sql` / 初始化配置 `sql` |
| `relations.add` | `relate` |
| `agent.instructions` / `agent.tools` | `instructions` / `tools` |
| 工具 list_datasets / describe_dataset / query | tables / schema / sql |
| 类型 IngestOptions / QueryOptions / QueryResult / Dataset | WriteOptions / SqlOptions / SqlResult / TableSchema |

CLI 仅保留 tables/schema/sql，移除旧的分组命令和维护入口。DataWorkspace 不再从包入口导出。SQLite 文件格式不变，无需迁移已有数据。SDK 默认结果上限由 1000 调整为 20，需要更多行时显式配置。

## 验证

```sh
npm test
npm run example
npm pack
```

测试覆盖 10 万行聚合、API 结果导入、持久化、事务回滚、查询限制、超时及 SDK/CLI/工具一致性。尚未验证具体模型的分析正确率。
