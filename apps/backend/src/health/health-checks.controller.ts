import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { MqttService } from '../iot/mqtt.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Bagimlilik saglik uclari (DEPLOYMENT.md 3). Yuk dengeleyici ve izleme icin: bagimlilik
 * saglikliysa 200, degilse 503. Giris gerektirmez ve ic hata ayrintisi dondurmez.
 * Redis henuz kullanilmadigindan (hiz siniri bellekte) `/health/redis` yoktur.
 */
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthChecksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
  ) {}

  @Get('db')
  async db(): Promise<{ db: 'ok' }> {
    if (!(await this.dbOk())) throw new ServiceUnavailableException({ db: 'down' });
    return { db: 'ok' };
  }

  @Get('mqtt')
  mqttHealth(): { mqtt: 'ok' } {
    if (!this.mqtt.isConnected) throw new ServiceUnavailableException({ mqtt: 'down' });
    return { mqtt: 'ok' };
  }

  /** Hepsi bir arada: yuk dengeleyicinin "trafik verilebilir mi" sorusu. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; db: 'ok'; mqtt: 'ok' }> {
    const db = await this.dbOk();
    const mqtt = this.mqtt.isConnected;
    if (!db || !mqtt) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        db: db ? 'ok' : 'down',
        mqtt: mqtt ? 'ok' : 'down',
      });
    }
    return { status: 'ok', db: 'ok', mqtt: 'ok' };
  }

  private async dbOk(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
