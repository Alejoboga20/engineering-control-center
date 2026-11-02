import { cpuPercentBetween, parseMemAvailable } from './system.service';

describe('system stats', () => {
  it('reads MemAvailable from /proc/meminfo as bytes', () => {
    const meminfo = 'MemTotal:       16000000 kB\nMemFree:         1000 kB\nMemAvailable:    8000000 kB\n';
    expect(parseMemAvailable(meminfo)).toBe(8000000 * 1024);
    expect(parseMemAvailable('MemTotal: 1 kB\n')).toBeNull();
  });

  it('computes CPU utilization from the change between samples', () => {
    const previous = { idle: 100, total: 200, at: 0 };
    expect(cpuPercentBetween(previous, { idle: 150, total: 300, at: 1 })).toBe(50);
    expect(cpuPercentBetween(previous, { idle: 100, total: 300, at: 1 })).toBe(100);
    expect(cpuPercentBetween(previous, previous)).toBe(0);
  });
});
