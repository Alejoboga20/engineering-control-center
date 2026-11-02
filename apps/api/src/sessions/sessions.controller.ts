import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { ProjectsResponse, SessionDto } from '@ecc/shared';
import { CreateSessionDto } from './create-session.dto';
import { ProjectDirectoriesService } from './project-directories.service';
import { SessionNamePipe } from './session-name.pipe';
import { SessionsService } from './sessions.service';

@Controller()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly directories: ProjectDirectoriesService,
  ) {}

  @Get('sessions')
  list(): Promise<SessionDto[]> {
    return this.sessions.list();
  }

  @Post('sessions')
  create(@Body() body: CreateSessionDto): Promise<SessionDto> {
    return this.sessions.create(body.name, body.workingDirectory);
  }

  @Delete('sessions/:name')
  @HttpCode(204)
  terminate(@Param('name', SessionNamePipe) name: string): Promise<void> {
    return this.sessions.terminate(name);
  }

  @Get('projects')
  projects(): Promise<ProjectsResponse> {
    return this.directories.listProjects();
  }
}
