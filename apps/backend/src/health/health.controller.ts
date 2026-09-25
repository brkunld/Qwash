import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@qwash/contracts';

const startedAt = Date.now();

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ description: 'Servis ayakta' })
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'qwash-backend',
      version: process.env.npm_package_version ?? '0.0.0',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}
