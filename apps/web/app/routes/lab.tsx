// 实测库：只放真的跑过一遍的评测与教程，按内容分排序，不参与新闻的 48 小时竞赛。
// 零基础读者最缺的是「这台机器到底跑不跑得动」这类答案，它们不该随新闻一起过期。
import type { Route } from "./+types/lab";
import type { LabResponse } from "../../../packages/backend/src/publication/lab";
import { useCallback } from "react";
import { Link, useLoaderData } from "react-router";
import { SITE } from "@tongxing/site";
import { edgeTtl, loadOr404, pageExpiresAt } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { FeedItem } from "../features/feed/FeedItem";
import { markRead, useReadSet } from "../lib/local-state";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "featured", name: "实测库" };
export const headers = () => edgeTtl(120);

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source")?.trim().slice(0, 80) || null;
  const qs = source ? `?source=${encodeURIComponent(source)}` : "";
  const data = await loadOr404<LabResponse>(`/api/site/lab${qs}`, { signal: request.signal });
  return { data, source, expiresAt: pageExpiresAt(120) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return pageMeta({
    title: "实测库",
    description: `${SITE.name} 实测库：本地部署、显卡显存、模型评测、Agent 与 MCP 的真实上机记录，按内容质量排序，不随新闻过期。`,
    path: "/lab",
  });
}

export default function Lab() {
  const { data, source } = useLoaderData<typeof loader>();
  const readSet = useReadSet();
  const onOpen = useCallback((id: string, title: string) => markRead(id, title), []);
  const total = data.sources.reduce((n, s) => n + s.count, 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 lg:pt-8">
      <header className="pb-4">
        <h1 className="text-xl font-semibold tracking-tight lg:text-2xl">实测库</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-500">
          真的跑过一遍的才进来：本地怎么部署、多少显存够用、哪个工具省钱、哪里会踩坑。
          共 {total} 篇，按内容质量排，不看发布日期。
        </p>
      </header>

      {data.sources.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Link
            to="/lab"
            className={`rounded-full border px-3 py-1 text-xs ${!source ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-600 hover:border-neutral-400"}`}
          >
            全部 {total}
          </Link>
          {data.sources.map((s) => (
            <Link
              key={s.id}
              to={`/lab?source=${encodeURIComponent(s.id)}`}
              className={`rounded-full border px-3 py-1 text-xs ${source === s.id ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 text-neutral-600 hover:border-neutral-400"}`}
            >
              {s.name} {s.count}
            </Link>
          ))}
        </div>
      )}

      {data.entries.length === 0 ? (
        <p className="py-16 text-center text-sm text-neutral-500">这一类还没有入库的实测。</p>
      ) : (
        <ol>
          {data.entries.map((e) => (
            <li key={e.item.id}>
              <FeedItem item={e.item} read={readSet.has(e.item.id)} onOpen={onOpen} showTags at={e.item.timelineAt} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
