'use client';

import type { AdminAuditEntry } from '@qwash/contracts';
import { Alert, Card, Empty, Loading, PageHeader, Table, TD, TH } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useLoad } from '@/lib/hooks';

const ACTION_LABEL: Record<string, string> = {
  CASH_TOPUP: 'Nakit yükleme',
  BALANCE_ADJUSTMENT: 'Bakiye düzeltme',
  REFUND_PAYOUT_SENT: 'Iyzico iadesi gönderildi',
  REFUND_PAYOUT_RESULT: 'Iyzico iade sonucu',
  REFUND_PAYOUT_RESOLVED: 'İade parçası sonuçlandırıldı',
  REFUND_COMPLETED: 'İade tamamlandı',
  REFUND_REJECTED: 'İade reddedildi',
  TOPUP_SETTINGS_UPDATED: 'Yükleme ayarları',
  ROLE_GRANTED: 'Rol verildi',
  BAY_MAINTENANCE_ON: 'Bakıma alındı',
  BAY_MAINTENANCE_OFF: 'Bakımdan çıkarıldı',
  SESSION_ADMIN_STOP: 'Acil durdurma',
  SESSION_REVIEWED: 'Seans incelendi',
  PROGRAM_CREATED: 'Program eklendi',
  PROGRAM_UPDATED: 'Program güncellendi',
  PROGRAM_DELETED: 'Program silindi',
  BAY_PROGRAMS_SET: 'Peron programları',
};

export default function AuditPage() {
  const log = useLoad(() => api<AdminAuditEntry[]>('/admin/audit-logs?limit=100'), [], 15000);

  return (
    <>
      <PageHeader
        title="Denetim kaydı"
        subtitle="Yöneticilerin para ve operasyon işlemleri. Kayıtlar değiştirilemez ve silinemez. Son 100."
      />
      {log.error && <Alert>{log.error}</Alert>}
      {log.loading && !log.data && <Loading />}
      {log.data && (
        <Card>
          {log.data.length === 0 ? (
            <Empty>Henüz kayıt yok.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={TH}>Zaman</th>
                  <th className={TH}>Yapan</th>
                  <th className={TH}>İşlem</th>
                  <th className={TH}>Gerekçe / ayrıntı</th>
                </tr>
              </thead>
              <tbody>
                {log.data.map((e) => (
                  <tr key={e.id}>
                    <td className={TD}>{dateTime(e.createdAt)}</td>
                    <td className={TD}>
                      {e.actorEmail ?? (e.actorId ? e.actorId : 'komut satırı')}
                    </td>
                    <td className={TD}>
                      {ACTION_LABEL[e.action] ?? e.action}
                      <div className="text-xs text-slate-500">
                        {e.targetType} {e.targetId ? e.targetId.slice(0, 8) : ''}
                      </div>
                    </td>
                    <td className={`${TD} max-w-md text-xs text-slate-600`}>
                      {e.reason && <p className="mb-1 text-sm text-slate-800">{e.reason}</p>}
                      {e.details ? (
                        <code className="break-all">{JSON.stringify(e.details)}</code>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
