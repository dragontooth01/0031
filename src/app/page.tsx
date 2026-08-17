import Link from "next/link";

const entries = [
  {
    title: "前台 · 亮宅操作端",
    href: "http://localhost:8000/liangzhai/",
    desc: "项目、客户、工程、预算、材料等日常操作端（原 Electron 桌面客户端 Web 版，1:1 复刻）",
    account: "18300000001 / 123456789",
    dot: "bg-emerald-400",
  },
  {
    title: "后台 · 装企后台管理系统",
    href: "http://localhost:8000/enterprise/",
    desc: "企业后台 14 个导航页面 1:1 复刻：成员、角色、企业信息、分公司、权限、设置、材料、项目定额、预算模板、材料模板、供应商、施工模板、我的模板、技术术语",
    account: "18300000001 / 123456",
    dot: "bg-sky-400",
  },
];

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-slate-950 px-6 py-16 text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(56,189,248,0.14),transparent),radial-gradient(50%_40%_at_80%_100%,rgba(52,211,153,0.12),transparent)]"
      />
      <div className="relative z-10 w-full max-w-3xl">
        <div className="text-center">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-slate-300">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            原样复用编译产物 · 界面与线上完全一致
          </p>
          <h1 className="text-3xl font-bold tracking-wide sm:text-4xl">
            亮宅 · 易施工 本地克隆系统
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-slate-400">
            前端（操作端 + 装企后台）100% 1:1 复刻；后端为零依赖 Node 服务器，
            API 真实代理 + 自动录制离线兜底（数据模式 auto / live / offline）。
          </p>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {entries.map((e) => (
            <Link
              key={e.title}
              href={e.href}
              target="_blank"
              rel="noreferrer"
              className="group rounded-2xl border border-white/10 bg-white/[0.04] p-6 transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.08]"
            >
              <h2 className="flex items-center gap-2.5 text-lg font-semibold">
                <span className={`size-2 rounded-full ${e.dot}`} />
                {e.title}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">{e.desc}</p>
              <p className="mt-4 text-xs text-slate-500">
                登录账号：<span className="font-mono text-slate-300">{e.account}</span>
              </p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-emerald-300 transition group-hover:gap-2">
                进入 <span aria-hidden>→</span>
              </span>
            </Link>
          ))}
        </div>

        <div className="mt-10 rounded-xl border border-white/10 bg-white/[0.03] p-5 text-xs leading-relaxed text-slate-400">
          <p className="mb-2 font-semibold text-slate-200">启动方式（克隆后端位于 clone/ 目录）</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              双击 <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-slate-200">clone\start.bat</code>{" "}
              或 <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-slate-200">cd clone &amp;&amp; node server.js</code>
              （默认端口 8000，零依赖）
            </li>
            <li>
              浏览器访问本页入口；离线兜底：
              <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-slate-200">
                set LZ_FIXTURE_MODE=offline &amp;&amp; node server.js
              </code>
            </li>
          </ol>
          <p className="mt-3 text-slate-500">
            详情见 <code className="font-mono">clone/README.md</code>。若 8000 端口被原版服务占用，可先停掉原版再启动克隆版，或用
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-slate-200"> set PORT=8010</code> 换端口。
          </p>
        </div>
      </div>
    </main>
  );
}
