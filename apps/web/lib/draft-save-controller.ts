/** Transport-free serialized autosave state machine. One writer, latest input retained. */
export type DraftSaveStatus = 'saved' | 'pending' | 'saving' | 'invalid' | 'error' | 'conflict';
export type DraftSaveState = { status: DraftSaveStatus; dirty: boolean; revision: number };
export class DraftSaveController<T, R> {
  private current: T;
  private acknowledged: string;
  private revision: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<R> | null = null;
  private disposed = false;
  private status: DraftSaveStatus = 'saved';
  private failure: unknown;
  private lastResult: R;
  constructor(
    private options: {
      initial: T;
      revision: number;
      initialResult: R;
      debounceMs?: number;
      validate: (draft: T) => boolean;
      persist: (draft: T, revision: number) => Promise<{ revision: number; result: R }>;
      changed: (state: DraftSaveState) => void;
      acknowledged?: (result: R, stillDirty: boolean) => void;
    },
  ) {
    this.current = options.initial;
    this.acknowledged = JSON.stringify(options.initial);
    this.revision = options.revision;
    this.lastResult = options.initialResult;
  }
  get state(): DraftSaveState {
    return {
      status: this.status,
      dirty: JSON.stringify(this.current) !== this.acknowledged,
      revision: this.revision,
    };
  }
  private emit(status: DraftSaveStatus) {
    this.status = status;
    if (!this.disposed) this.options.changed(this.state);
  }
  update(draft: T) {
    if (this.disposed || JSON.stringify(draft) === JSON.stringify(this.current)) return;
    this.current = draft;
    clearTimeout(this.timer);
    if (this.status === 'conflict') {
      this.emit('conflict');
      return;
    }
    if (this.active) {
      this.emit('saving');
      return;
    }
    if (!this.state.dirty) {
      this.emit('saved');
      return;
    }
    if (!this.options.validate(draft)) {
      this.emit('invalid');
      return;
    }
    this.emit('pending');
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, this.options.debounceMs ?? 900);
  }
  async flush(): Promise<R> {
    clearTimeout(this.timer);
    if (this.disposed) throw new Error('SAVE_DISPOSED');
    if (this.active) return this.active;
    if (this.status === 'conflict') throw this.failure;
    if (!this.state.dirty) {
      this.emit('saved');
      return this.lastResult;
    }
    const run = async () => {
      while (this.state.dirty && !this.disposed) {
        if (!this.options.validate(this.current)) {
          this.emit('invalid');
          throw new Error('INVALID_DRAFT');
        }
        const sent = structuredClone(this.current),
          fingerprint = JSON.stringify(sent);
        this.emit('saving');
        try {
          const result = await this.options.persist(sent, this.revision);
          if (!Number.isSafeInteger(result.revision) || result.revision < this.revision)
            throw new Error('INVALID_SAVE_ACK');
          this.revision = result.revision;
          this.acknowledged = fingerprint;
          this.lastResult = result.result;
          if (!this.disposed) this.options.acknowledged?.(result.result, this.state.dirty);
        } catch (error) {
          this.failure = error;
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : '';
          this.emit(code === 'STALE_STATE' ? 'conflict' : 'error');
          throw error;
        }
      }
      this.emit('saved');
      return this.lastResult;
    };
    this.active = run().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
