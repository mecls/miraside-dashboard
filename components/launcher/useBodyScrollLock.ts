"use client";

import { useEffect } from "react";

/**
 * Lock page scroll while a full-screen launcher overlay (the ad-set board, the review sheet) is mounted,
 * so wheel-scrolling over the fixed overlay can't scroll the page hidden behind it. Compensates for the
 * vanishing scrollbar with matching padding so nothing janks sideways, and restores everything on unmount.
 */
export function useBodyScrollLock() {
  useEffect(() => {
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const scrollbar = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
    };
  }, []);
}
