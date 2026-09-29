import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact, type TaskEventType } from '@ao/core';
import type { WorkerEvent } from '@ao/contracts';

/**
 * Durable local event buffer (spec §85, §107). Every event is appended to a JSONL file before being
 * sent, so events survive network outages and worker restarts. Each event has an eventId (server
 * dedupe key) and a per-worker monotonically increasing sequence. Acknowledged events are compacted.
 */
export class EventBuffer {
  private pending: WorkerEvent[] = [];
  private sequence = 0;
  private file: string;
  private seqFile: string;
  private flushing = false;

  constructor(
    dir: string,
    private workerId: () => string | null,
    private maxPending = 50_000,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'events.jsonl');
    this.seqFile = path.join(dir, 'events.seq');
    this.sequence = Number(fs.existsSync(this.seqFile) ? fs.readFileSync(this.seqFile, 'utf8') : 0) || 0;
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.pending.push(JSON.parse(line));
        } catch {
          /* torn write at crash: skip the partial line */
        }
      }
    }
  }

  get size() {
    return this.pending.length;
  }

  /** Most recent events (sent or not), newest last — for the local UI log view. */
  private ring: WorkerEvent[] = [];
  recent(limit = 200): WorkerEvent[] {
    return this.ring.slice(-limit);
  }

  push(taskId: string, type: TaskEventType, payload: Record<string, unknown> = {}, correlationId?: string): WorkerEvent {
    const e: WorkerEvent = {
      eventId: randomUUID(),
      workerId: this.workerId() ?? 'unpaired',
      taskId,
      timestamp: new Date().toISOString(),
      sequence: ++this.sequence,
      type,
      payload: redact(payload),
      correlationId,
    };
    this.pending.push(e);
    this.ring.push(e);
    if (this.ring.length > 500) this.ring.shift();
    fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    if (this.sequence % 50 === 0) fs.writeFileSync(this.seqFile, String(this.sequence));
    // Bound memory/disk: drop the oldest *ephemeral* output first if the buffer is huge.
    if (this.pending.length > this.maxPending) {
      const idx = this.pending.findIndex((p) => p.type === 'AgentOutput');
      this.pending.splice(idx >= 0 ? idx : 0, 1);
    }
    return e;
  }

  /**
   * Send in order, in batches. Stops at the first failure and keeps unsent events (spec §107).
   * A call made while another flush runs waits for it and then sends what is still pending, so
   * "after flush() resolves, everything buffered before the call was sent" holds (e.g. on shutdown).
   */
  async flush(send: (batch: WorkerEvent[]) => Promise<void>, batchSize = 200): Promise<number> {
    while (this.current) await this.current.catch(() => undefined);
    if (!this.pending.length) return 0;
    const run = this.drain(send, batchSize);
    this.current = run;
    try {
      return await run;
    } finally {
      this.current = null;
    }
  }

  private current: Promise<number> | null = null;

  private async drain(send: (batch: WorkerEvent[]) => Promise<void>, batchSize: number): Promise<number> {
    this.flushing = true;
    let sent = 0;
    try {
      while (this.pending.length) {
        const wid = this.workerId();
        const batch = this.pending.slice(0, batchSize).map((e) => (e.workerId === 'unpaired' && wid ? { ...e, workerId: wid } : e));
        await send(batch);
        this.pending.splice(0, batch.length);
        sent += batch.length;
      }
    } finally {
      this.compact();
      this.flushing = false;
    }
    return sent;
  }

  private compact() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.pending.map((e) => JSON.stringify(e)).join('\n') + (this.pending.length ? '\n' : ''));
    fs.renameSync(tmp, this.file);
    fs.writeFileSync(this.seqFile, String(this.sequence));
  }
}
