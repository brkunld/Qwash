import { createReadStream } from 'node:fs';
import { basename, join } from 'node:path';
import { Controller, Get, Inject, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DeviceOpsService } from './device-ops.service';

/** Klasor: firmware imajlarinin durdugu yer (FIRMWARE_DIR). */
export const FIRMWARE_DIR = Symbol('FIRMWARE_DIR');

/**
 * Cihazin firmware indirmesi (ADR-0013). Giris yok: anahtar yalniz o cihaza, MQTT (TLS, ACL)
 * uzerinden verilmistir; tek guncellemeye ozel ve kisa omurludur. Bilinmeyen/suresi dolmus
 * anahtar ile imaj yokmus gibi 404 doner.
 */
@ApiTags('firmware')
@Controller('firmware')
export class FirmwareController {
  constructor(
    private readonly deviceOps: DeviceOpsService,
    @Inject(FIRMWARE_DIR) private readonly firmwareDir: string,
  ) {}

  @Get('download/:token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async download(@Param('token') token: string): Promise<StreamableFile> {
    const file = await this.deviceOps.resolveDownload(token);
    if (!file) throw new NotFoundException();
    return new StreamableFile(createReadStream(join(this.firmwareDir, basename(file.fileName))), {
      type: 'application/octet-stream',
      length: file.sizeBytes,
    });
  }
}
