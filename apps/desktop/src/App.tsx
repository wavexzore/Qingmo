import { APP_NAME, APP_NAME_LATIN, APP_TAGLINE } from "@qingmo/shared";
import { cx } from "@qingmo/ui";

export function App() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[radial-gradient(circle_at_18%_12%,rgba(44,106,90,0.16),transparent_34%),linear-gradient(135deg,#e7e1d5,#d8e3dc)] p-6 font-sans text-[#1d1c19]">
      <section
        className={cx(
          "w-full max-w-[520px] rounded-[24px] border border-black/10 bg-[#fbf8f1] p-10",
          "shadow-[0_36px_90px_rgba(53,43,27,0.18),0_2px_10px_rgba(53,43,27,0.06)]",
        )}
      >
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-[#2c6a5a] font-serif text-lg text-[#fbf8f1] shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]">
            青
          </span>
          <div>
            <h1 className="font-serif text-2xl tracking-[0.06em]">{APP_NAME}</h1>
            <p className="text-[9px] tracking-[0.24em] text-[#8b8377]">{APP_NAME_LATIN}</p>
          </div>
        </div>

        <p className="mt-10 text-balance font-serif text-[32px] leading-[1.3] tracking-[-0.04em]">
          {APP_TAGLINE}
        </p>
        <p className="mt-4 text-sm leading-7 text-[#555047]">
          工程骨架已就绪。文件打开、编辑与保存将在后续任务接入。
        </p>

        <div className="mt-9 flex items-center gap-2 border-t border-black/10 pt-5 text-[11px] text-[#8b8377]">
          <span className="size-1.5 rounded-full bg-[#2c6a5a] shadow-[0_0_0_3px_rgba(44,106,90,0.08)]" />
          本地优先 · 文件不离开设备
        </div>
      </section>
    </main>
  );
}
