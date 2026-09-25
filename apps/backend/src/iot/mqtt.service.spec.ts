import { redactUrl } from './mqtt.service';

describe('redactUrl', () => {
  it('sifreyi gizler, kullanici ve host kalir', () => {
    expect(redactUrl('mqtt://qwash-backend:s3cret@localhost:11883')).toBe(
      'mqtt://qwash-backend:***@localhost:11883',
    );
  });
  it('kimliksiz URL degismez', () => {
    expect(redactUrl('mqtt://localhost:11883')).toBe('mqtt://localhost:11883');
  });
  it('gecersiz URL sifreyi sizdirmaz', () => {
    expect(redactUrl('::bozuk:s3cret')).not.toContain('s3cret');
  });
});
