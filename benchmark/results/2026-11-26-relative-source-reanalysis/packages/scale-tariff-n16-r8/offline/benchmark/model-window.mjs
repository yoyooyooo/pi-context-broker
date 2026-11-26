/** An open condition epoch has no expiry. Its start still identifies which
 * observations belong together; historical bounded windows retain their end. */
export function isStandingWindow(window) {
  return window?.mode === 'standing' && window.end === null;
}

export function modelWindowEnd(window) {
  return isStandingWindow(window) ? Infinity : Date.parse(window?.end);
}

export function validModelWindow(window) {
  const start = Date.parse(window?.start), end = modelWindowEnd(window);
  return Number.isFinite(start) && (window?.mode === undefined || isStandingWindow(window)) && start < end;
}

export function modelWindowContains(window, now = Date.now()) {
  return validModelWindow(window) && now >= Date.parse(window.start) && now < modelWindowEnd(window);
}

export function modelWindowCondition(window) {
  return { start: Date.parse(window.start), end: window.end === null ? null : Date.parse(window.end),
    ...(isStandingWindow(window) ? { mode: 'standing' } : {}) };
}
