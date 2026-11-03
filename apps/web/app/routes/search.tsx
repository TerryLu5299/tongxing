import { redirect } from "react-router";

/**
 * Search lives on the all page (`/all?q=…`), which owns the results list, the filters and the
 * full-text toggle. The in-site assistant and older links still point at `/search`, so keep that
 * address working instead of answering it with a 404.
 */
export function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  return redirect(`/all${url.search}`);
}

export function headers() {
  return { "Cache-Control": "no-store" };
}
