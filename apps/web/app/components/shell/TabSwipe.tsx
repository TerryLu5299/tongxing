// The phone shell's tab level (below lg). Two behaviors for the four tab pages:
//  1. window.__tongxingIsRoot marks a tab page — the 同行 shell's back gesture leaves the app there
//     instead of walking history, and only sub-pages go back a level.
//  2. Swiping left/right on a tab page (away from the screen edges, which belong to the OS back
//     gesture) moves to the next/previous tab with the same slide the tab bar's links use.
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { tabs } from "./nav";
import { isPhone } from "./screens";
import { markBack } from "./transitions";

declare global {
  interface Window {
    /** Read by the shell (MainActivity) on the Android back gesture. */
    __tongxingIsRoot?: boolean;
  }
}

/** Exact match: /daily/archive is deeper than the /daily tab, so it is not a tab page. */
function isTabRoot(pathname: string): boolean {
  return tabs().some((t) => t.to === pathname);
}

export function TabSwipe() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tabRoot = isTabRoot(pathname);

  // 第1条：告诉壳"当前是一级界面"（未标记时壳按有历史回退，行为同上一版）。
  useEffect(() => {
    window.__tongxingIsRoot = tabRoot;
    return () => {
      window.__tongxingIsRoot = false;
    };
  }, [tabRoot]);

  // 第2条：一级界面上横滑切 Tab。只在手机壳里启用。
  useEffect(() => {
    if (!tabRoot || !isPhone()) return;
    // CSS px：屏幕两缘留给系统的返回手势（Android 边缘区约 24-32dp）。
    const EDGE = 40;
    const ACTIVATE = 14; // 认定横滑主导的最小位移
    const TRIGGER = 56; // 松手要滑够才切
    const MAX_CROSS = 64; // 允许的最大纵向偏移
    let start: { x: number; y: number } | null = null;
    let swiping = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || document.documentElement.style.overflow === "hidden") {
        start = null;
        return;
      }
      const x = e.touches[0]!.clientX;
      if (x < EDGE || x > window.innerWidth - EDGE) {
        start = null; // 系统手势区
        return;
      }
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) {
        start = null; // 浮层盖着页面时不管
        return;
      }
      start = { x, y: e.touches[0]!.clientY };
      swiping = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!start) return;
      if (!swiping) {
        const dx = e.touches[0]!.clientX - start.x;
        const dy = e.touches[0]!.clientY - start.y;
        if (Math.abs(dx) > ACTIVATE && Math.abs(dx) > Math.abs(dy) * 1.4) swiping = true;
        else if (Math.abs(dy) > ACTIVATE) {
          start = null; // 纵向主导：滚动/下拉刷新的地盘，让开
          return;
        } else return;
      }
      // 已确认横滑：不让页面把它当滚动消费掉（与下拉刷新互斥，它在横滑时也会放弃）。
      if (e.cancelable) e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.changedTouches[0]!.clientX - start.x;
      const dy = Math.abs(e.changedTouches[0]!.clientY - start.y);
      start = null;
      if (!swiping || Math.abs(dx) < TRIGGER || dy > MAX_CROSS) return;
      const list = tabs();
      const i = list.findIndex((t) => t.to === pathname);
      if (i < 0) return;
      if (dx < 0 && i < list.length - 1) {
        // 左滑：下一个 Tab，新页从右滑入（push 方向）。
        navigate(list[i + 1]!.to, { viewTransition: true });
      } else if (dx > 0 && i > 0) {
        // 右滑：上一个 Tab，新页从左滑入（back 方向）。
        markBack();
        navigate(list[i - 1]!.to, { viewTransition: true });
      }
      // 已经在两端：不动。
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [tabRoot, pathname, navigate]);

  return null;
}
