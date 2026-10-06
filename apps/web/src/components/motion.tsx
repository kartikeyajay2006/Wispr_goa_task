import {useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One observer for the whole app: any element with class "reveal" fades in when it enters the
 * viewport. Elements added later (route changes, streamed agent events) are picked up too.
 */
export function installRevealObserver() {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
  const reduced = prefersReducedMotion();
  const visible = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-in'); visible.unobserve(entry.target); }
  }, {rootMargin: '0px 0px -8% 0px', threshold: 0.08});
  const scan = (root: ParentNode) => root.querySelectorAll?.('.reveal:not(.is-in)').forEach(element => reduced ? element.classList.add('is-in') : visible.observe(element));
  scan(document);
  new MutationObserver(mutations => { for (const mutation of mutations) mutation.addedNodes.forEach(node => { if (node instanceof HTMLElement) { if (node.matches('.reveal:not(.is-in)')) (reduced ? node.classList.add('is-in') : visible.observe(node)); scan(node); } }); })
    .observe(document.body, {childList: true, subtree: true});
}

/** Cursor-following light on any element with class "spotlight" (one listener, CSS does the rest). */
export function installSpotlight() {
  if (typeof window === 'undefined' || prefersReducedMotion() || !window.matchMedia('(pointer: fine)').matches) return;
  document.addEventListener('pointermove', event => {
    const target = (event.target as Element | null)?.closest?.('.spotlight') as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    target.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }, {passive: true});
}

/** Animates a number from its previous value to the new one. */
export function CountUp({value, duration = 900, format = (n: number) => Math.round(n).toLocaleString()}: {value: number; duration?: number; format?: (n: number) => string}) {
  const [shown, setShown] = useState(prefersReducedMotion() ? value : 0);
  const from = useRef(prefersReducedMotion() ? value : 0);
  useEffect(() => {
    if (prefersReducedMotion()) { setShown(value); from.current = value; return; }
    const start = performance.now(), origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(origin + (value - origin) * eased);
      if (t < 1) frame = requestAnimationFrame(tick); else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); from.current = value; };
  }, [value, duration]);
  return <>{format(shown)}</>;
}

/** A sliding underline that follows the selected tab inside a tab list. */
export function TabInk({container, activeKey}: {container: RefObject<HTMLElement | null>; activeKey: string}) {
  const [box, setBox] = useState<{left: number; top: number; width: number; height: number} | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (active) setBox({left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [container, activeKey]);
  if (!box) return null;
  return <span className="tab-ink" aria-hidden="true" style={{transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height}} />;
}

/** Resolves with the action's result, but not before `ms`, so quick actions still show their progress. */
export async function atLeast<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (prefersReducedMotion()) return promise;
  const [result] = await Promise.all([promise, new Promise(resolve => setTimeout(resolve, ms))]);
  return result;
}
