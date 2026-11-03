import { useEffect, useState } from "react";
import { Link } from "react-router";
import { SITE } from "@tongxing/site";
import { edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { clearReadHistory, useReadHistory } from "../lib/local-state";
import { fullDateTime, relativeTime } from "../lib/format";
import { IconClose, IconHistory } from "../components/icons";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: "阅读历史" };

export function headers() {
  return edgeTtl(300);
}

export function meta() {
  return pageMeta({ title: "阅读历史", description: `这台设备上最近打开过的 ${SITE.name} 内容。`, path: "/history", noindex: true });
}

/**
 * "阅读历史": the last 50 articles this browser opened, newest first. Like 收藏, it lives only in this
 * browser; clearing it also clears the read marks the feed greys out.
 */
export default function HistoryPage() {
  const history = useReadHistory();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const action = "text-[12.5px] text-ink-3 transition-colors hover:text-accent";
  return (
    <div className="pb-12">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="阅读历史" actions={mounted && history.length > 0 ? (
        <button type="button" onClick={() => clearReadHistory()} className={`${action} inline-flex items-center gap-1`}>
          <IconClose size={13} /> 清空
        </button>
      ) : undefined} />
      <header className="pb-4 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">阅读历史</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">{`这台设备上最近打开过的 ${SITE.name} 内容，保留最近 50 条。`}</p>
      </header>
      <p className="rounded-tile border border-line bg-surface px-4 py-2.5 text-[12.5px] text-ink-3">记录只保存在当前浏览器；清除浏览器数据或换设备后不会同步。清空历史同时清除已读标记。</p>
      {!mounted ? null : history.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
          <IconHistory size={20} className="text-ink-4" />
          <p className="mt-3 text-[13px] text-ink-3">还没有阅读记录。点开任意一条内容即可开始记录。</p>
          <Link to="/" className="mt-4 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            去看精选 →
          </Link>
        </div>
      ) : (
        <ul className="mt-3 lg:space-y-3">
          {history.map((h) => (
            <li key={h.id} data-card-key={h.id} className="relative border-b border-line-soft py-4 lg:card lg:card-hover lg:px-[18px] lg:py-[15px]">
              <div className="flex items-center gap-2 text-[12.5px] text-ink-4">
                <span className="shrink-0">
                  于 <span className="num">{relativeTime(h.at)}</span> 打开
                  <span className="hidden sm:inline"> · <span className="num">{fullDateTime(h.at)}</span></span>
                </span>
              </div>
              <h2 className="mt-1.5 text-[16px] font-[650] leading-[1.55] text-ink">
                <Link viewTransition to={`/items/${h.id}`} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent">
                  {h.title || `#${h.id}`}
                </Link>
              </h2>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
