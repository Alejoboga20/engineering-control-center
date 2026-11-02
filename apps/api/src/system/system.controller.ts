import { Controller, Get } from '@nestjs/common';
import type { SystemStatsDto } from '@ecc/shared';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('stats')
  stats(): Promise<SystemStatsDto> {
    return this.system.getStats();
  }
}
