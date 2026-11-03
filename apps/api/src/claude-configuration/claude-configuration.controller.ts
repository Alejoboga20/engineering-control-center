import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import type {
  ClaudeConfigScopesResponse,
  ClaudeHooksResponse,
  ClaudeResourceDetail,
  ClaudeResourceListResponse,
  ClaudeSettingsResponse,
} from '@ecc/shared';
import { ClaudeConfigQueryDto } from './claude-config-query.dto';
import { ClaudeConfigurationService } from './claude-configuration.service';

/** GET only, by design. Responses stay out of the browser's disk cache. */
@Controller('claude/config')
export class ClaudeConfigurationController {
  constructor(private readonly configuration: ClaudeConfigurationService) {}

  @Get('scopes')
  @Header('Cache-Control', 'no-store')
  scopes(): Promise<ClaudeConfigScopesResponse> {
    return this.configuration.listScopes();
  }

  @Get('agents')
  @Header('Cache-Control', 'no-store')
  agents(@Query() query: ClaudeConfigQueryDto): Promise<ClaudeResourceListResponse> {
    return this.configuration.listAgents(query);
  }

  @Get('skills')
  @Header('Cache-Control', 'no-store')
  skills(@Query() query: ClaudeConfigQueryDto): Promise<ClaudeResourceListResponse> {
    return this.configuration.listSkills(query);
  }

  @Get('knowledge')
  @Header('Cache-Control', 'no-store')
  knowledge(@Query() query: ClaudeConfigQueryDto): Promise<ClaudeResourceListResponse> {
    return this.configuration.listKnowledge(query);
  }

  @Get('hooks')
  @Header('Cache-Control', 'no-store')
  hooks(@Query() query: ClaudeConfigQueryDto): Promise<ClaudeHooksResponse> {
    return this.configuration.listHooks(query);
  }

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings(@Query() query: ClaudeConfigQueryDto): Promise<ClaudeSettingsResponse> {
    return this.configuration.getSettings(query);
  }

  @Get('resources/:resourceId')
  @Header('Cache-Control', 'no-store')
  resource(@Param('resourceId') resourceId: string): Promise<ClaudeResourceDetail> {
    return this.configuration.getResource(resourceId);
  }
}
