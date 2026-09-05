export function countPendingTimers(vi: { getTimerCount(): number }): number {
  const count = vi.getTimerCount();
  if (count !== 0) {
    const clock = (
      globalThis.setInterval as unknown as {
        clock?: {
          timers: Record<string, { id: number; type: string; interval?: number; func: Function }>;
          jobs?: unknown[];
        };
      }
    ).clock;
    console.error(
      "BROKER_TIMER_DIAGNOSTIC",
      JSON.stringify({
        count,
        clockPresent: Boolean(clock),
        timers:
          clock &&
          Object.values(clock.timers).map((timer) => ({
            id: timer.id,
            type: timer.type,
            interval: timer.interval,
            callback: String(timer.func).slice(0, 2000),
          })),
        jobs: clock ? (clock.jobs?.length ?? 0) : undefined,
      }),
    );
  }
  return count;
}
