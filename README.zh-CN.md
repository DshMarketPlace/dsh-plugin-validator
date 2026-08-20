<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-241f1a?style=flat-square"></a>
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-none-6b6055?style=flat-square">
  <img alt="Requires" src="https://img.shields.io/badge/requires-docker%20%2B%20node%2022-6b6055?style=flat-square">
  <a href="https://dshmarketplace.dev"><img alt="Used by" src="https://img.shields.io/badge/已实测-2%2C426%20个插件-c0561d?style=flat-square"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

---

把一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件装进
一次性容器里的干净 profile，然后报告 **harness 自己记下了什么** —— 而不是 CLI 打印了
什么。

[dshmarketplace.dev](https://dshmarketplace.dev) 上每条插件的安装结论，就是这个东西跑
出来的。

## 为什么 exit code 不算证据

`dsh plugin add` 在什么都没装上的时候也返回 `0`。在一台没有 pnpm 的机器上就是这样：它
把原因打出来，然后告诉你成功了。

所以这里根本不看 exit code。装完之后去读 harness 自己写的 profile manifest ——
`$DSH_HOME/profiles/web/package.json` —— 看 `dsh.profile.bundles` 里有没有它。在那儿
才算装上了，别的都不算。

命令是**原样整条传进去的，跟 catalogue 上发布的一模一样**。要测的是别人会复制的那条命令，
不是我们自己拼出来的版本。

## 六种结论

其中**只有两种是真的坏了**。

| 结论 | 含义 | 算不算问题 |
| --- | --- | --- |
| `passed` | 装上了，而且注册进了 profile 的 `bundles` | — |
| `not-a-layer` | 装是装上了，但它没声明 `dsh.bundle`，所以是个普通依赖。theme、agent bundle、库都落在这里；harness 自己也说了，以后版本补上就会自动生效 | — |
| `needs-approval` | 解析和落盘都没问题，但 build script 被 pnpm 拦了。加一条 `allowBuilds` 就能用 | — |
| `rejected` | 这串东西不是 `dsh plugin add` 命令，或者目标既不是 npm 包名也不是 `github:` spec。什么都没跑 | — |
| `failed` | 装上了但没注册、manifest 根本没写出来，或者 `package.json` 开头带 UTF-8 BOM | **是** |
| `timeout` | 超过 180 秒 | **是** |

后两类里有两个是被第一版判错才单独拆出来的。`not-a-layer` 在 `failed` 桶里待了一天，
把能用的 theme 判成坏的，理由只是它不是同一种包。`needs-approval` 管的是源码安装时
pnpm 拒绝跑 `prepare` —— 而源码安装本来就必须干这件事。

**429 永远不是结论。** registry 限流的时候 probe 给的是 `error`，下游不会拿它发布任何
东西。这条分支的由来是：曾经有 119 个能用的插件被 npm 限流判成坏的，另外 28 个死在
`codeload.github.com` 上 —— 源码安装要从 GitHub 拉 tarball，GitHub 同样限流。谁的 429
不重要，它量的永远是我们自己的流量，不是插件。

## 怎么用

```console
$ docker build -t dsh-validator:latest .
```

单个插件：

```console
$ docker run --rm dsh-validator:latest "dsh plugin --profile web add @liustack/modlens"
{"status":"passed","detail":"installed and registered in the web profile","bundles":["@liustack/modlens"],"dependencies":["@liustack/modlens"],"blockedBuildScripts":[]}
```

批量 —— 一行一个 JSON，要 `fullName` 和 `install` 两个字段：

```console
$ cat specs.jsonl
{"fullName":"liustack/modlens","install":"dsh plugin --profile web add @liustack/modlens"}
{"fullName":"someone/other","install":"dsh plugin --profile web add github:someone/other"}

$ node run.mjs specs.jsonl results.jsonl 3
2 specs, 0 already done, 2 to run
  2/2

{
  "passed": 1,
  "needs-approval": 1
}
```

**可断点续跑。** 结果是跑完一条追加一条，已经有结果的直接跳过，所以跑到第二小时挂掉只赔
第二小时，不用从头再来。

| 环境变量 | 默认值 | |
| --- | --- | --- |
| `VALIDATOR_IMAGE` | `dsh-validator:latest` | 用哪个镜像 |
| `VALIDATOR_MEMORY` | `1500m` | 单容器内存**和** swap 上限 |
| `VALIDATOR_CPUS` | `1.0` | 单容器 CPU 上限 |
| `PROBE_TIMEOUT_MS` | `180000` | 容器内的安装超时 |

默认值是故意压低的：这东西跑在一台还跑着别人服务的机器上，一批校验把别人饿死，比跑一整晚
更糟。

## 隔离

插件的安装步骤是陌生人的代码，所以一个插件一个容器，跑完就销毁。

- `--rm`，一插件一容器，跑完什么都不留
- `--cap-drop ALL` 加 `--security-opt no-new-privileges`
- 用镜像里的非特权 `node` 用户跑，不是 root
- **不挂载宿主目录** —— 没有出去的路
- 内存、swap、`--pids-limit 512` 都封顶
- 300 秒的墙钟 kill，比 probe 自己的超时更长，卡死的容器占不住槽位

runner **故意做成文件进、文件出，手上没有任何凭据**。一个能摸到数据库 token 的
`postinstall` 就等于拿到了整个数据库，所以跑不可信安装脚本的那个进程，手上就不该有东西可
摸。marketplace 的 nightly job 里这就是单独一个 CI job：一个 job 算出要测哪些，这个 job
负责跑，第三个 job 把结果读回去。

网络是开着的（`--network bridge`），因为要测的就是"能不能装上"。这是沙箱诚实的边界：它约
束的是安装过程**在宿主上能碰到什么**，不是它能往外发什么。

## 它测出来的东西

**先测出的是我们自己的 bug，不是别人的。** 第一次全量跑回来 410 个 failed，里面几乎没有
真坏的插件：

- **852 条声明了 npm 包的记录里，412 条是错的** —— 362 条写的包压根没发布过，50 条写的是
  别人的包。这里面绝大多数是 fork：fork 会原样继承上游的 `package.json`，于是 fork 的卡片
  上印的是上游的安装命令。我们装了陌生人的代码，还差点把它的失败挂在 fork 作者名下。
- 另外 119 个是 npm 在限流我们，28 个是 GitHub 在干同样的事。
- 18 个是跑到一半改 probe 弄出来的。

剩下的是个位数百分比，大多是 monorepo 和 workspace 的解析错误 —— 外加一个值得单独点名的：
`package.json` 存成了带 UTF-8 BOM 的，`JSON.parse` 在哪儿都不认。Windows 上的编辑器是悄悄
加的，作者自己根本看不见。所以这条结论会把原因直接说出来，而不是丢进泛泛的 failed 里。

**"读代码"已经两次没能发现根本跑不起来的命令，"真去装一遍"两次都发现了。**

## 为什么钉 pnpm 10 而不是 11

镜像里钉 pnpm 10 是有意的。pnpm 11 在 `ERR_PNPM_IGNORED_BUILDS` 上返回非零，`dsh` 把这个
读成安装失败，于是在写 bundle 那一行之前就停了 —— **同一个插件**在 11 上是
`needs-approval`，在 10 上是 `passed`。这是包管理器的事实，不是插件的事实；钉住版本才能让
结论说的是插件。

镜像用 `node:22-bookworm` 而不是 `-slim`，也是同一类原因：`@deepseek-ai/dsh` 依赖
`node-pty`，它没有 arm64 预编译产物，npm 只能回落到 node-gyp，于是需要 python 和一套 C++
工具链。在 slim 上安装会死在 `gyp ERR! not ok`，看起来像包坏了，其实是缺编译器。

## 同一个 catalogue 的其他入口

- **网站** —— [dshmarketplace.dev](https://dshmarketplace.dev)
- **npm** —— `npx dshmarketplace-cli find memory`
- **PyPI** —— `pip install dshmarketplace`
- **DSH 里面** —— `dsh plugin --profile web add dshmarketplace-plugin`
- **油猴脚本** —— [DSH Plugin Radar](https://greasyfork.org/scripts/591735-dsh-plugin-radar)

## 参与

欢迎提 issue 和 PR，尤其是你觉得判错了的结论。如果是**某条记录**本身写错了，那属于
[marketplace 仓库](https://github.com/DshMarketPlace/dshmarketplace) —— 数据在那边，不在
这里。

## 授权

MIT。独立项目，与 DeepSeek 官方无关。
