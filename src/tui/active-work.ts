/**
 * The ACTIVE work tracker shared by runs and manual /compact. A /restart
 * must signal and drain whichever operation is in flight — a run OR a
 * compaction — so both register here, and runRestartSequence reads it.
 *
 * Identity-guarded: completion of an OLDER tracked operation never clears a
 * NEWER one's slot. Pure (no Ink, no I/O) so the production entry points
 * (track / current / clear-on-settle) are unit-testable directly.
 */
export interface ActiveWorkHandle {
  readonly promise: Promise<unknown>;
  readonly abort: AbortController | null;
}

export class ActiveWork {
  private handle: ActiveWorkHandle | null = null;

  /** Register an in-flight operation; its slot clears when it settles
   *  (resolved OR rejected), but only if it is still the current one. */
  track(promise: Promise<unknown>, abort: AbortController | null): void {
    const h: ActiveWorkHandle = { promise, abort };
    this.handle = h;
    void promise.then(
      () => this.clear(h),
      () => this.clear(h),
    );
  }

  current(): ActiveWorkHandle | null {
    return this.handle;
  }

  private clear(h: ActiveWorkHandle): void {
    if (this.handle === h) this.handle = null;
  }
}
