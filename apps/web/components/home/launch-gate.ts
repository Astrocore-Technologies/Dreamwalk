export type LaunchLease = { generation: number; selection: string };
/** One user-started creation at a time; changing screens cannot revive an old response. */
export class LaunchGate {
  private generation = 0;
  private pending = false;
  private alive = true;
  private selection = '';
  get busy() {
    return this.pending;
  }
  select(id: string) {
    this.selection = id;
  }
  activate() {
    this.alive = true;
  }
  begin(): LaunchLease | null {
    if (!this.alive || this.pending) return null;
    this.pending = true;
    return { generation: ++this.generation, selection: this.selection };
  }
  accepts(lease: LaunchLease) {
    return this.alive && lease.generation === this.generation && lease.selection === this.selection;
  }
  finish(lease: LaunchLease) {
    if (lease.generation !== this.generation) return false;
    this.pending = false;
    return this.alive;
  }
  dispose() {
    this.alive = false;
    this.generation++;
    this.pending = false;
  }
}
