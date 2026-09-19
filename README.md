# dsh-first-party

第一方 **DeepSeek Harness (DSH)** 插件集合。

定位很窄：把那些**体量小、启动开销大、功能可替代**的第三方 bundle，换成自己掌控的实现。
不是要重写生态里的大块头，而是只吃掉真正拖慢启动的那几个。

## 为什么存在

在 25 个 bundle（2 个官方 + 23 个第三方）的 profile 上做装前/装后对照实测：

| 现象 | 数据 |
|---|---|
| 历史工作区分组数 | 82 → 11（清理后） |
| `host-boot` 阶段耗时 | **42.3s → 22.1s** |
| 单个插件净增启动耗时 | `dsh-recall-plugin` **+4.2s** |

瓶颈不在计算量，而在**启动期创建的 shell 子进程数**：每个历史工作目录会拉起一条
无并发上限的 6 段异步链，每段 spawn 一次 shell。工作目录越多，启动越慢，且与
"用户此刻是否真的要用这个功能"完全无关。

## 包含的包

| 包 | 替代目标 | 核心改动 | 状态 |
|---|---|---|---|
| [`@dsh-first-party/recall-lite`](packages/recall-lite) | `dsh-recall-plugin` | 启动期 eager 预热 → 按需 lazy 初始化 | v0.1.0 |

## 安装

```bash
# 从 git 源安装（构建产物已入库，无需本地构建）
dsh plugin --profile desktop add "github:AEmbers/dsh-first-party#main"
```

> 具体到 `recall-lite` 的安装、卸载与回退原插件的双向步骤，见
> [`packages/recall-lite/README.md`](packages/recall-lite/README.md)。

## 许可与来源

MIT。`packages/recall-lite` 是 [dsh-recall-plugin](https://github.com/limbo947/dsh-recall-plugin)
（MIT，基线 2.3.24）的衍生作品——保留上游的完整实现与许可，只做定向重构。
完整的衍生声明见 [`LICENSE`](LICENSE)，改动清单见 [`docs/plan.md`](docs/plan.md)。
