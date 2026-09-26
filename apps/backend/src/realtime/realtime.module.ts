import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { Env } from '../config/env';
import { SessionModule } from '../session/session.module';
import { SessionChangeListener } from './session-change.listener';
import { SessionGateway } from './session.gateway';

@Module({
  imports: [AuthModule, SessionModule],
  providers: [
    {
      provide: SessionChangeListener,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new SessionChangeListener(config.get('DATABASE_URL', { infer: true })),
    },
    SessionGateway,
  ],
})
export class RealtimeModule {}
