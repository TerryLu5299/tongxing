import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import type { ReportLatestPage } from "@tongxing/contracts/site";
import { REPORTS, subjectAfter, withSubject } from "@tongxing/site";
import { edgeTtl, loadOr404, pageExpiresAt } from "../lib/api.server";
import { cachedLoader } from "../lib/page-reuse";
import { pageMeta, reportLd } from "../lib/seo";
import { beijingDate } from "@tongxing/contracts/time";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { KIND_LABEL, feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "日报" };
export { shouldRevalidate } from "../lib/page-reuse";
export const clientLoader = cachedLoader<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const { index, report } = await loadOr404<ReportLatestPage>(`/api/site/reports/${kind}/latest-page`, { signal: request.signal });
  return { kind, report, index, today: beijingDate(Date.now()), expiresAt: pageExpiresAt(600) };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const kind = loaderData?.kind ?? "daily";
  const description = `${REPORTS.descriptions[kind]}。`;
  const report = loaderData?.report;
  return [...pageMeta({
    title: withSubject(KIND_LABEL[kind]),
    description,
    path: location.pathname,
    image: `/og/pages/${kind}.png`,
    // The latest issue, described at this page's own address (its canonical).
    jsonLd: report ? reportLd(report, location.pathname, report.lead?.leadParagraph ?? description) : undefined,
  }), feedLink(kind)];
}

export function headers() {
  return edgeTtl(600);
}

export default function ReportLatestPage() {
  const { kind, report, index, today } = useLoaderData<typeof loader>();
  // A latest issue that is days old means the site stopped producing, not that nothing happened.
  // Say so on the page instead of presenting an old issue as today's.
  const staleDays = report
    ? Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(report.key + "T00:00:00Z")) / 86400000)
    : 0;
  return (
    <ReportLayout kind={kind} index={index} current={report?.key ?? null} today={today} outline={report ? reportOutline(report) : []}>
      {staleDays >= 2 && (
        <p style={{ margin: "0 0 20px", padding: "12px 16px", borderRadius: 10, background: "var(--surface-2, rgba(127,127,127,.08))", color: "var(--text-2, inherit)", fontSize: 14, lineHeight: 1.7 }}>
          这里是 {report!.key} 的一期。之后有 {staleDays} 天的{KIND_LABEL[kind]}因站点内容链路故障没有出刊，已在修复中，恢复后每天按时更新。
        </p>
      )}
      {report ? <ReportPaper report={report} index={index} /> : <EmptyState title={subjectAfter("还没有发布", KIND_LABEL[kind])}>第一期发布后会出现在这里。</EmptyState>}
    </ReportLayout>
  );
}
