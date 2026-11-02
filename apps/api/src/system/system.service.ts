import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import { Injectable } from '@nestjs/common';
import type { SystemStatsDto } from '@ecc/shared';

const DISK_PATH = '/';
const MIN_SAMPLE_INTERVAL_MS = 500;

interface CpuSample {
  idle: number;
  total: number;
  at: number;
}

function sampleCpu(now: number): CpuSample {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, at: now };
}

export function cpuPercentBetween(previous: CpuSample, current: CpuSample): number {
  const total = current.total - previous.total;
  if (total <= 0) return 0;
  const busy = total - (current.idle - previous.idle);
  return Math.min(100, Math.max(0, Math.round((busy / total) * 1000) / 10));
}

/** Parses MemAvailable from /proc/meminfo, in bytes. */
export function parseMemAvailable(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

@Injectable()
export class SystemService {
  private previousSample = sampleCpu(Date.now());
  private cpuPercent = 0;

  async getStats(): Promise<SystemStatsDto> {
    const [availableBytes, disk] = await Promise.all([this.availableMemory(), statfs(DISK_PATH)]);
    const totalBytes = totalmem();
    return {
      cpuPercent: this.currentCpuPercent(),
      memory: {
        totalBytes,
        usedBytes: Math.max(0, totalBytes - availableBytes),
        availableBytes,
      },
      disk: {
        path: DISK_PATH,
        totalBytes: disk.blocks * disk.bsize,
        availableBytes: disk.bavail * disk.bsize,
      },
      uptimeSeconds: Math.floor(uptime()),
    };
  }

  /** Needs no background timer. The measurement covers the time since the previous request. */
  private currentCpuPercent(): number {
    const now = Date.now();
    if (now - this.previousSample.at >= MIN_SAMPLE_INTERVAL_MS) {
      const sample = sampleCpu(now);
      this.cpuPercent = cpuPercentBetween(this.previousSample, sample);
      this.previousSample = sample;
    }
    return this.cpuPercent;
  }

  /** os.freemem() ignores reclaimable page cache on Linux, so MemAvailable is preferred. */
  private async availableMemory(): Promise<number> {
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => null);
    return (meminfo ? parseMemAvailable(meminfo) : null) ?? freemem();
  }
}
