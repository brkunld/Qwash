# QWASH — Testing Strategy & Quality Assurance

Bu doküman, QWASH platformunun test piramidini, arıza senaryoları simülasyonunu ve otomatik kalite denetimlerini tanımlar.

---

## 1. Test Piramidi ve Araçlar

```text
               / \
              /   \
             / E2E \         Playwright (Müşteri & Admin Web Akışları)
            /-------\
           / Contract\       Pact / Zod Schema Tests (Frontend/Backend/IoT)
          /-----------\
         / Integration \     Supertest + Testcontainers (PostgreSQL, Redis, MQTT)
        /---------------\
       /      Unit       \   Jest (Ledger, State Machine, Servis Mantıkları)
      /-------------------\
```

| Test Katmanı | Araçlar | Kapsam |
|---|---|---|
| **Unit Tests** | Jest | Cüzdan hesaplamaları (kuruş), durum makinesi geçiş kuralları, DTO validasyonları |
| **Integration Tests** | Supertest, Testcontainers | PostgreSQL transaction testleri, Redis Redlock kilitleri, Outbox worker akışı |
| **Contract Tests** | Zod, TypeScript | Frontend ile Backend DTO uyumu, Backend ile ESP32 JSON payload uyumu |
| **E2E Tests** | Playwright | Tarayıcıda QR okuma, bakiye yükleme, seans başlatma ve canlı geri sayım |
| **Load / Stress** | k6 | 100+ eşzamanlı kullanıcının aynı anda seans başlatması (Race condition testi) |

---

## 2. Kritik Arıza Senaryoları Matrisi (Chaos Testing)

Sistemin gerçek saha arızalarına karşı davranışını garanti eden test senaryoları:

| Arıza Senaryosu | Beklenen Sistem Davranışı | Doğrulama Yöntemi |
|---|---|---|
| **MQTT Bağlantısı Koptu** | Outbox worker komutları bekletir, broker gelince sırayla aktarır. Seans `START_TIMEOUT` ile bakiyeyi iade eder. | Docker MQTT konteyneri durdurularak test edilir. |
| **ESP32 Yıkama Ortasında Yeniden Başladı** | Cihaz NVS belleğinden seansı okur, süreyi kaldığı yerden devam ettirir. | ESP32'ye hardware reset atılarak doğrulanır. |
| **Eşzamanlı Çift START İsteği** | Redlock ve Pessimistic lock ilk isteği işler, ikinci isteği "Peron Meşgul" olarak reddeder. | Eşzamanlı 10 HTTP POST isteği gönderilerek test edilir. |
| **ACK Mesajı 10 Saniye Gecikti** | Backend seansı `FAILED` yapar, bloke edilen parayı kullanıcıya iade eder (`RELEASED`). | Mock MQTT istemcisinde ACK geciktirilerek test edilir. |
| **İyzico Webhook'u İletilmedi** | Reconciliation worker İyzico API'sini sorgular ve bakiyeyi kullanıcı hesabına geçirir. | Webhook endpoint'i engellenerek cron worker test edilir. |

---

## 3. Eşzamanlı Bakiye (Double-Spending) Test Kodu Örneği

```typescript
describe('Wallet Concurrency & Double-Spending Protection', () => {
  it('should not allow overspending when 5 requests hit simultaneously', async () => {
    // 1. Kullanıcıya 100 TL (10000 kuruş) tanımla
    const wallet = await createTestWallet({ balanceKurus: 10000 });
    
    // 2. Aynı anda 30 TL (3000 kuruş) tutarında 5 paralel harcama isteği at (Toplam: 15000 TL)
    const requests = Array(5).fill(null).map(() => 
      walletService.holdFunds(wallet.id, 3000, uuid())
    );

    const results = await Promise.allSettled(requests);
    const successful = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    // 3. Yalnızca 3 istek başarılı olmalı, 2 istek "Yetersiz Bakiye" almalı
    expect(successful.length).toBe(3);
    expect(failed.length).toBe(2);

    // 4. Son bakiye kesinlikle 1000 kuruş kalmalı, asla negatif olmamalı
    const finalWallet = await walletService.getWallet(wallet.id);
    expect(finalWallet.balanceKurus).toBe(10000n);
    expect(finalWallet.holdKurus).toBe(9000n);
  });
});
```
