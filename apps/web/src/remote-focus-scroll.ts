// WKWebView may animate the native scroll view to a tapped input even when
// overflow is hidden and focus({preventScroll:true}) is used. Hide only the
// input while transferring focus, before WebKit calculates its reveal scroll.
// Restore before the next paint; the composer and page never move or disappear.
export function preventRemoteFocusScroll(root: HTMLElement): () => void {
  let touch: { id: number; x: number; y: number; protectFocus: boolean } | undefined;
  const viewport = window.visualViewport;
  let fullHeight = viewport?.height ?? window.innerHeight;
  let lastResize = -Infinity;
  const keyboardVisible = () => !!viewport && fullHeight - viewport.height > 100;
  const resize = () => {
    fullHeight = Math.max(fullHeight, viewport?.height ?? window.innerHeight);
    lastResize = performance.now();
  };
  const restores = new Map<HTMLElement, () => void>();
  const supported = () => /iP(?:hone|ad|od)/.test(navigator.userAgent);
  const inputFor = (target: EventTarget | null) => {
    // Search label padding and its icon activate the input too. Resolve the
    // associated control before allowing the label's default focus action.
    if (target instanceof Element && !(target instanceof HTMLInputElement)) {
      const label = target.closest<HTMLLabelElement>("label.remote-search");
      if (label && root.contains(label)) target = label.control;
    }
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (
      !target.matches(
        ".remote-search input, .remote-rich-composer textarea, .remote-question-form textarea, .remote-message-edit textarea",
      ) ||
      target.disabled ||
      target.readOnly
    )
      return;
    return target;
  };
  const hideForFocus = (input: HTMLElement) => {
    // A second focus in the same frame must not inherit the first restore.
    restores.get(input)?.();
    const opacity = input.style.getPropertyValue("opacity");
    const priority = input.style.getPropertyPriority("opacity");
    input.style.setProperty("opacity", "0", "important");
    const frame = requestAnimationFrame(() => restore());
    const restore = () => {
      cancelAnimationFrame(frame);
      if (opacity) input.style.setProperty("opacity", opacity, priority);
      else input.style.removeProperty("opacity");
      restores.delete(input);
    };
    restores.set(input, restore);
  };
  const start = (event: TouchEvent) => {
    const first = event.touches[0];
    const input = inputFor(event.target);
    const protectFocus =
      !!input &&
      (input !== document.activeElement ||
        !keyboardVisible() ||
        performance.now() - lastResize < 250);
    touch =
      event.touches.length === 1 && first
        ? { id: first.identifier, x: first.clientX, y: first.clientY, protectFocus }
        : undefined;
  };
  const cancel = () => {
    touch = undefined;
  };
  const move = (event: TouchEvent) => {
    const current = Array.from(event.touches).find((item) => item.identifier === touch?.id);
    if (!current || !touch || Math.hypot(current.clientX - touch.x, current.clientY - touch.y) > 10)
      cancel();
  };
  const end = (event: TouchEvent) => {
    const tap = touch;
    cancel();
    if (!tap || event.touches.length || !supported() || !event.cancelable || event.defaultPrevented)
      return;
    const input = inputFor(event.target);
    // Snapshot the decision on touchstart: native focus may already have
    // changed activeElement by touchend. DOM focus alone does not mean the
    // keyboard is open (iOS Done can dismiss it while retaining DOM focus).
    if (!input || !tap.protectFocus) return;
    event.preventDefault();
    const selection = [input.selectionStart, input.selectionEnd, input.selectionDirection] as const;
    if (input === document.activeElement && !keyboardVisible()) input.blur();
    hideForFocus(input);
    input.focus({ preventScroll: true });
    if (selection[0] !== null && selection[1] !== null)
      input.setSelectionRange(selection[0], selection[1], selection[2] ?? "none");
  };
  const focus = (event: FocusEvent) => {
    const input = inputFor(event.target);
    if (supported() && input) hideForFocus(input);
  };
  viewport?.addEventListener("resize", resize);
  root.addEventListener("touchstart", start, { passive: true, capture: true });
  root.addEventListener("touchmove", move, { passive: true, capture: true });
  root.addEventListener("touchcancel", cancel, true);
  root.addEventListener("touchend", end, { passive: false, capture: true });
  root.addEventListener("focus", focus, true);
  return () => {
    viewport?.removeEventListener("resize", resize);
    root.removeEventListener("touchstart", start, true);
    root.removeEventListener("touchmove", move, true);
    root.removeEventListener("touchcancel", cancel, true);
    root.removeEventListener("touchend", end, true);
    root.removeEventListener("focus", focus, true);
    for (const restore of restores.values()) restore();
  };
}
