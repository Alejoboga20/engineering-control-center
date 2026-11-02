import type { ProjectsResponse, SessionDto, SystemStatsDto } from '@ecc/shared';

export const alpha: SessionDto = {
  name: 'alpha',
  createdAt: '2026-01-01T00:00:00.000Z',
  attachedClients: 0,
  windows: 1,
  manageable: true,
};

export const beta: SessionDto = { ...alpha, name: 'beta', attachedClients: 1, windows: 3 };

export const stats: SystemStatsDto = {
  cpuPercent: 12.5,
  memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 },
  disk: { path: '/', totalBytes: 100 * 1024 ** 3, availableBytes: 75 * 1024 ** 3 },
  uptimeSeconds: 90000,
};

export const projects: ProjectsResponse = {
  roots: ['/home/dev/projects'],
  directories: [{ name: 'payroll', path: '/home/dev/projects/payroll' }],
};
