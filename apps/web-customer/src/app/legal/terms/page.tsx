import type { Metadata } from 'next';
import { H, LegalPage, Ul } from '@/components/legal';
import { COMPANY } from '@/lib/company';

export const metadata: Metadata = { title: 'Kullanım Şartları | QWash' };

export default function TermsPage() {
  return (
    <LegalPage title="Kullanım Şartları">
      <p>
        Bu şartlar, {COMPANY.legalName} (&quot;{COMPANY.brand}&quot;) tarafından işletilen
        self-servis oto yıkama istasyonlarını ve bu istasyonlara bağlanmak için kullanılan mobil web
        uygulamasını (&quot;Uygulama&quot;) kullanmanızın koşullarını belirler. Hesap oluşturarak bu
        şartları kabul etmiş olursunuz.
      </p>

      <H>1. Hizmet</H>
      <p>
        Peronun ekranında gösterilen QR kodu okutarak perona bağlanır, bakiyenizle bir yıkama
        programı ve süre seçer ve yıkamayı başlatırsınız. Hizmet saniye bazında ücretlendirilir;
        program fiyatları seçim ekranında gösterilir.
      </p>

      <H>2. Hesap</H>
      <Ul>
        <li>
          Hesap için ad soyad, e-posta adresi ve şifre gerekir; bilgilerin doğru olması sizin
          sorumluluğunuzdadır.
        </li>
        <li>
          Şifrenizi gizli tutmalı, hesabınızdan yapılan işlemlerden sorumlu olduğunuzu bilmelisiniz.
        </li>
        <li>
          İlk başarılı kart yüklemesinden sonra ad soyad bilginiz değiştirilemez; iadeler bu ada
          yapılır.
        </li>
      </Ul>

      <H>3. Bakiye yükleme</H>
      <Ul>
        <li>
          Bakiye, Türk lirası cinsinden kartla (Iyzico güvenli ödeme sayfası üzerinden) veya
          istasyon kasasında nakit olarak yüklenebilir.
        </li>
        <li>
          Kart bilgileriniz {COMPANY.brand} sunucularına iletilmez ve saklanmaz; ödeme Iyzico
          tarafından alınır.
        </li>
        <li>Asgari yükleme tutarı Uygulamada gösterilir ve değişebilir.</li>
        <li>Bakiye faiz getirmez, başkasına devredilemez.</li>
      </Ul>

      <H>4. Ücretlendirme</H>
      <Ul>
        <li>
          Yıkama başlarken seçtiğiniz süre için en fazla tutar bakiyenizde ayrılır (bloke edilir).
        </li>
        <li>Yalnızca fiilen kullandığınız süre ücretlendirilir; kalan tutar bakiyenize döner.</li>
        <li>
          Yıkamayı erken durdurursanız durdurma komutunun peron cihazına ulaşması için tanınan en
          fazla 5 saniyelik pay dışında, durdurma anından sonraki süre için ücret alınmaz.
        </li>
        <li>
          Peron yıkamayı başlatamazsa veya cihaz komuta yanıt vermezse ücret alınmaz, ayrılan tutar
          bakiyenize döner.
        </li>
        <li>
          Peronla bağlantı yıkama bittikten sonra koparsa, cihazdan sonuç gelene kadar en fazla 30
          dakika beklenir; gelmezse yalnızca kanıtlanmış kullanım ücretlendirilir, kalanı bakiyenize
          döner.
        </li>
      </Ul>

      <H>5. İade politikası</H>
      <Ul>
        <li>Yüklenen bakiye kural olarak iade edilmez.</li>
        <li>
          İstisnalar: (a) teknik arıza veya hizmeti alamama nedeniyle destek talebiniz onaylanırsa,
          (b) hesabınızı silerken kalan bakiyeniz için iade talep ederseniz.
        </li>
        <li>
          İade, ödemenin yapıldığı karta yapılır; başka bir kart veya hesaba yapılmaz. Ödemeden 365
          günden fazla geçtiyse kart iadesi teknik olarak mümkün değildir; bu tutar yalnızca kendi
          adınıza kayıtlı bir IBAN&apos;a gönderilebilir.
        </li>
        <li>
          İade talepleri otomatik işlenmez; yetkili yönetici onayıyla işlenir. Talep süresince
          ilgili tutar bloke kalır.
        </li>
        <li>Hesabı silerken bakiyenizden vazgeçebilirsiniz; bu durumda tutar geri alınamaz.</li>
      </Ul>

      <H>6. Hesabın silinmesi</H>
      <p>
        Hesabınızı Uygulamadan silebilirsiniz. Süren bir yıkamanız veya sonuçlanmamış bir ödemeniz
        varken silme yapılamaz. Silinen hesabın kişisel verileri anonimleştirilir; yasal saklama
        yükümlülüğü olan mali kayıtlar kimliğinizden ayrıştırılarak tutulur (bkz. KVKK Aydınlatma
        Metni).
      </p>

      <H>7. Kullanım kuralları</H>
      <Ul>
        <li>Peron üzerindeki talimatlara ve güvenlik uyarılarına uymalısınız.</li>
        <li>
          Basınçlı su ve yıkama ürünlerini insanlara, hayvanlara veya yıkama dışı amaçlara
          yöneltmemelisiniz.
        </li>
        <li>
          Perona, cihazlara veya Uygulamaya zarar vermeye, güvenlik önlemlerini aşmaya veya
          başkasının hesabını kullanmaya çalışmamalısınız.
        </li>
        <li>Çocukların peronda gözetimsiz bırakılmaması sizin sorumluluğunuzdadır.</li>
      </Ul>

      <H>8. Sorumluluk</H>
      <p>
        {COMPANY.brand}, hizmeti özenle sunar; ancak elektrik, su veya internet kesintisi gibi
        nedenlerle peronun geçici olarak kullanılamamasından doğan dolaylı zararlardan sorumlu
        değildir. Kusurumuzdan kaynaklanmayan araç, eşya veya kişisel zararlardan, yasaların izin
        verdiği ölçüde sorumluluk kabul edilmez. Tüketici olarak kanundan doğan haklarınız saklıdır.
      </p>

      <H>9. Değişiklikler</H>
      <p>
        Şartları ve fiyatları güncelleyebiliriz. Önemli değişiklikler Uygulamada duyurulur;
        değişiklikten sonra hizmeti kullanmaya devam etmeniz yeni şartları kabul ettiğiniz anlamına
        gelir. Başlamış bir yıkama, başladığı andaki fiyat üzerinden ücretlendirilir.
      </p>

      <H>10. Uyuşmazlıklar ve iletişim</H>
      <p>
        Bu şartlara Türk hukuku uygulanır. Uyuşmazlıklarda tüketici hakem heyetleri ve tüketici
        mahkemeleri yetkilidir. Sorularınız ve talepleriniz için: {COMPANY.email}, {COMPANY.phone}.
      </p>
      <p className="text-slate-500">
        {COMPANY.legalName} · {COMPANY.address} · Vergi: {COMPANY.taxOffice} · MERSİS:{' '}
        {COMPANY.mersis}
      </p>
    </LegalPage>
  );
}
