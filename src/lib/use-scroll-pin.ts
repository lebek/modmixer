import { useCallback, useEffect, useRef, useState, type DependencyList, type RefObject } from 'react';

/**
 * Pin a scroll container to its bottom edge while content is appended,
 * but let the user scroll back to read history without yanking them
 * down on the next update.
 *
 * The user is "pinned" while their scrollTop is within `slack` pixels of
 * the bottom. A wheel/touch/keyboard gesture unpins immediately so a
 * smooth-scroll animation in flight doesn't get mistaken for the user.
 *
 * Pass deps that should re-trigger the scroll-to-bottom (messages,
 * streaming flag, etc.). Returns:
 * - `pinned` — currently pinned to the bottom
 * - `hasNewBelow` — content arrived while unpinned
 * - `jumpToBottom()` — programmatically re-pin and scroll
 *
 * `instantOnFirstRun` makes the very first scroll instant (use when the
 * container has just mounted and we don't want a long animation through
 * the whole transcript).
 *
 * `scrollToEnd` overrides how the bottom is reached. A virtualized list
 * can't just `scrollTo(scrollHeight)` — unmeasured rows make scrollHeight an
 * estimate — so it passes a function that drives the virtualizer instead.
 */
export function useScrollPin(
  ref: RefObject<HTMLElement | null>,
  deps: DependencyList,
  options: {
    slack?: number;
    instantOnFirstRun?: boolean;
    scrollToEnd?: (smooth: boolean) => void;
  } = {},
): {
  pinned: boolean;
  hasNewBelow: boolean;
  jumpToBottom: () => void;
  /** Reset the "first run" flag — call from your conversation-switch effect. */
  resetFirstRun: () => void;
} {
  const { slack = 64, instantOnFirstRun = true, scrollToEnd } = options;
  const [pinned, setPinned] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const justSwitched = useRef(instantOnFirstRun);
  const programmatic = useRef(false);
  const programmaticTimer = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const updatePinned = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance < slack;
      setPinned(atBottom);
      if (atBottom) setHasNewBelow(false);
    };

    const onScroll = () => {
      if (programmatic.current) return;
      updatePinned();
    };

    const onUserGesture = () => {
      programmatic.current = false;
      if (programmaticTimer.current !== null) {
        window.clearTimeout(programmaticTimer.current);
        programmaticTimer.current = null;
      }
      updatePinned();
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onUserGesture, { passive: true });
    el.addEventListener('touchstart', onUserGesture, { passive: true });
    el.addEventListener('touchmove', onUserGesture, { passive: true });
    el.addEventListener('keydown', onUserGesture);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onUserGesture);
      el.removeEventListener('touchstart', onUserGesture);
      el.removeEventListener('touchmove', onUserGesture);
      el.removeEventListener('keydown', onUserGesture);
    };
  }, [ref, slack]);

  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      const el = ref.current;
      if (!el) return;
      programmatic.current = true;
      if (scrollToEnd) {
        scrollToEnd(smooth);
      } else {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: smooth ? 'smooth' : 'auto',
        });
      }
      if (programmaticTimer.current !== null) {
        window.clearTimeout(programmaticTimer.current);
      }
      programmaticTimer.current = window.setTimeout(
        () => {
          programmatic.current = false;
          programmaticTimer.current = null;
        },
        smooth ? 600 : 50,
      );
    },
    [ref, scrollToEnd],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const instant = justSwitched.current;
    justSwitched.current = false;
    if (instant || pinned) {
      scrollToBottom(!instant);
    } else {
      setHasNewBelow(true);
    }
    // Caller's deps drive when to scroll; ref/scrollToBottom/pinned are stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const jumpToBottom = useCallback(() => {
    scrollToBottom(true);
    setPinned(true);
    setHasNewBelow(false);
  }, [scrollToBottom]);

  const resetFirstRun = useCallback(() => {
    justSwitched.current = true;
    setPinned(true);
    setHasNewBelow(false);
  }, []);

  return { pinned, hasNewBelow, jumpToBottom, resetFirstRun };
}
