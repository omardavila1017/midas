/**
 * Yield to the browser so queued input (clicks, scrolls) gets a chance
 * to run before we re-enter a heavy synchronous block.
 *
 * Uses `MessageChannel` because it produces a true macrotask without
 * the 4ms clamp that older browsers impose on `setTimeout(0)`.
 */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * Schedule heavy work to run on the next idle slot, with proper cancel.
 * Differs from a bare `requestIdleCallback` in that the returned
 * cancel function flips a flag the callback can inspect — caller can
 * skip remaining sub-steps when the user has navigated away.
 */
export function scheduleCancellable(
  run: (signal: { aborted: boolean }) => void,
  options: { timeout?: number } = {},
): () => void {
  const signal = { aborted: false };
  const win = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(() => {
      if (signal.aborted) return;
      run(signal);
    }, { timeout: options.timeout ?? 500 });
    return () => {
      signal.aborted = true;
      win.cancelIdleCallback?.(id);
    };
  }
  const id = window.setTimeout(() => {
    if (signal.aborted) return;
    run(signal);
  }, 0);
  return () => {
    signal.aborted = true;
    window.clearTimeout(id);
  };
}
