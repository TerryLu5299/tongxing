import { Form, Link, useLoaderData, useNavigation } from "react-router";
import { SITE } from "@tongxing/site";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { ReadingLayout } from "../components/ui/Page";
import { PhoneBar } from "../components/shell/PhoneBar";
import { isPhone, type Screen } from "../components/shell/screens";

/**
 * Ask the site a question. The answer comes from the API's /api/site/ask, which searches what has
 * already been published and refuses to answer beyond it — the page's job is to show the citations
 * as plainly as the answer, so a reader can check it in one click.
 */
export const handle: Screen = { tab: "featured", name: "问一句" };

export function headers() {
  return { "Cache-Control": "no-store" };
}

export function meta() {
  return pageMeta({
    title: "问一句",
    description: `向 ${SITE.name} 提一个问题：答案只从站内已发布的内容里找，并附上来源，没有就直说没有。`,
    path: "/ask",
    noindex: true,
  });
}

interface AskResponse {
  answer: string;
  citations: Array<{ n: number; title: string; url: string; source: string; at: string | null }>;
  hits: number;
  model: string;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!q) return { q, answer: null as AskResponse | null, failed: false };
  try {
    const answer = await apiGet<AskResponse>(`/api/site/ask?q=${encodeURIComponent(q)}`);
    return { q, answer, failed: false };
  } catch {
    return { q, answer: null, failed: true };
  }
}

export default function Ask() {
  const { q, answer, failed } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const asking = navigation.state === "loading";
  const hasAnswer = !!answer?.answer;

  return (
    <ReadingLayout>
      {isPhone() && <PhoneBar title="问一句" tab="featured" />}

      <header className="pb-1 pt-2">
        <h1 className="text-[24px] font-semibold leading-8 text-ink">问一句</h1>
        <p className="mt-2 text-[14px] leading-6 text-ink-3">
          只在站里已经发布的内容里找答案，每条答案都带来源。站里没有的，会直接告诉你没有。
        </p>
      </header>

      <Form method="get" className="mt-5 flex items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          autoFocus={!q}
          placeholder="比如：本地跑大模型要什么显卡"
          className="min-w-0 flex-1 rounded-xl bg-bg-sunk px-4 py-3 text-[15px] text-ink outline-none ring-1 ring-inset ring-line placeholder:text-ink-4 focus:ring-accent"
        />
        <button
          type="submit"
          disabled={asking}
          className="shrink-0 rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-bg disabled:opacity-60"
        >
          {asking ? "找…" : "问"}
        </button>
      </Form>

      {failed && (
        <p className="mt-6 rounded-xl bg-bg-sunk px-4 py-3 text-[14px] text-ink-2">
          这次没答上来，可能是模型忙。稍等一下再问一次。
        </p>
      )}

      {!failed && q && !hasAnswer && (
        <div className="mt-6 rounded-xl bg-bg-sunk px-4 py-4">
          <p className="text-[15px] leading-7 text-ink">
            站里还没有讲到「{q}」。
          </p>
          <p className="mt-1 text-[14px] text-ink-3">
            换个说法，或者去
            <Link to={`/all?q=${encodeURIComponent(q)}`} className="mx-1 text-accent hover:underline">
              全部动态里搜关键词
            </Link>
            ，那里能看到相关条目。
          </p>
        </div>
      )}

      {hasAnswer && (
        <section className="mt-6">
          <div className="rounded-xl bg-surface px-4 py-4 ring-1 ring-inset ring-line">
            <p className="whitespace-pre-line text-[15px] leading-7 text-ink">{answer!.answer}</p>
          </div>

          {answer!.citations.length > 0 && (
            <div className="mt-4">
              <h2 className="text-[13px] font-medium text-ink-4">来源</h2>
              <ol className="mt-2 space-y-2">
                {answer!.citations.map((c) => (
                  <li key={c.n} className="text-[14px] leading-6">
                    <Link to={c.url} className="text-ink-2 hover:text-accent">
                      [{c.n}] {c.title}
                    </Link>
                    <span className="ml-1 text-ink-4">
                      {c.source}
                      {c.at ? ` · ${c.at.slice(0, 10)}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      {!q && (
        <div className="mt-6 space-y-2 text-[14px] leading-6 text-ink-3">
          <p>可以这样问：</p>
          {["什么是 MCP，能干什么", "本地跑大模型要什么显卡", "有没有 AI 编程工具的实测"].map((s) => (
            <p key={s}>
              <Link to={`/ask?q=${encodeURIComponent(s)}`} className="text-ink-2 hover:text-accent">
                · {s}
              </Link>
            </p>
          ))}
        </div>
      )}
    </ReadingLayout>
  );
}
