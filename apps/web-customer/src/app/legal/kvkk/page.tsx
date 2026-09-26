import type { Metadata } from 'next';
import { H, LegalPage, Ul } from '@/components/legal';
import { COMPANY } from '@/lib/company';

export const metadata: Metadata = { title: 'KVKK Aydınlatma Metni | QWash' };

export default function KvkkPage() {
  return (
    <LegalPage title="KVKK Aydınlatma Metni">
      <p>
        6698 sayılı Kişisel Verilerin Korunması Kanunu (&quot;KVKK&quot;) m.10 uyarınca, kişisel
        verilerinizin nasıl işlendiğini açıklıyoruz.
      </p>

      <H>1. Veri sorumlusu</H>
      <p>
        {COMPANY.legalName} · {COMPANY.address} · {COMPANY.email}
      </p>

      <H>2. İşlenen veriler</H>
      <Ul>
        <li>
          <strong>Hesap:</strong> ad soyad, e-posta adresi, şifreniz (yalnızca geri döndürülemez
          özet olarak), Google ile girişte Google hesabınızın e-posta ve ad bilgisi.
        </li>
        <li>
          <strong>İşlem:</strong> bakiye hareketleri, yükleme kayıtları, yıkama seansları (peron,
          program, süre, tutar, zaman).
        </li>
        <li>
          <strong>Ödeme:</strong> ödeme sağlayıcısının verdiği işlem numarası ve sonucu. Kart
          numaranız ve güvenlik kodunuz bize iletilmez ve saklanmaz.
        </li>
        <li>
          <strong>Teknik:</strong> IP adresi, tarayıcı bilgisi ve güvenlik/hata kayıtları;
          oturumunuzu sürdürmek için gerekli oturum çerezi.
        </li>
        <li>
          <strong>İade talebinde:</strong> IBAN ve hesap sahibi adı (yalnızca IBAN&apos;a iade
          gerektiğinde).
        </li>
      </Ul>

      <H>3. İşleme amaçları ve hukuki sebepler</H>
      <Ul>
        <li>
          Hesabınızı oluşturmak, hizmeti ve ödemeyi yürütmek: sözleşmenin kurulması ve ifası
          (m.5/2-c).
        </li>
        <li>
          Mali kayıtları tutmak, vergi ve ticaret mevzuatındaki saklama yükümlülüklerini yerine
          getirmek: hukuki yükümlülük (m.5/2-ç).
        </li>
        <li>
          Dolandırıcılık ve kötüye kullanımı önlemek, sistem güvenliğini sağlamak, hataları
          gidermek: meşru menfaat (m.5/2-f).
        </li>
        <li>Hakkın tesisi, kullanılması veya korunması, olası uyuşmazlıklarda ispat: m.5/2-e.</li>
      </Ul>
      <p>Bu amaçlar için açık rızanız aranmaz. Pazarlama amaçlı iletişim yapılmaz.</p>

      <H>4. Verilerin aktarıldığı taraflar</H>
      <Ul>
        <li>
          <strong>Ödeme kuruluşu (Iyzico):</strong> ödeme ve iade işlemleri için.
        </li>
        <li>
          <strong>Altyapı ve e-posta hizmeti sağlayıcıları:</strong> uygulamanın barındırılması ve
          doğrulama/şifre sıfırlama e-postalarının gönderilmesi için.
        </li>
        <li>
          <strong>Google:</strong> yalnızca &quot;Google ile giriş&quot; kullanırsanız, kimlik
          doğrulama için.
        </li>
        <li>
          <strong>Yetkili kurum ve kuruluşlar:</strong> mevzuat gereği talep halinde.
        </li>
      </Ul>
      <p>
        Hizmet sağlayıcılarımızın yurt dışında bulunması halinde aktarım KVKK m.9 hükümlerine uygun
        yapılır. Verileriniz satılmaz.
      </p>

      <H>5. Saklama süreleri</H>
      <Ul>
        <li>Hesap ve oturum verileri, hesabınız açık olduğu sürece.</li>
        <li>
          Hesabı sildiğinizde ad, e-posta ve doğrudan kimliğinizi belirleyen bilgiler
          anonimleştirilir. İade talebi için verdiğiniz bilgiler talep sonuçlanana kadar tutulur.
        </li>
        <li>
          Bakiye, ödeme ve seans gibi mali kayıtlar, kimliğinizden ayrıştırılmış olarak, ilgili
          mevzuatın öngördüğü süre boyunca (genel olarak 10 yıla kadar) saklanır ve süre sonunda
          silinir veya yok edilir.
        </li>
      </Ul>

      <H>6. Çerezler</H>
      <p>
        Yalnızca oturumunuzu güvenle sürdürmek için gerekli bir oturum çerezi kullanılır. Reklam
        veya izleme çerezi kullanılmaz.
      </p>

      <H>7. Haklarınız (KVKK m.11)</H>
      <p>
        Verilerinizin işlenip işlenmediğini öğrenme, bilgi talep etme, amacına uygun kullanılıp
        kullanılmadığını öğrenme, aktarıldığı tarafları bilme, eksik veya yanlış işlenmişse
        düzeltilmesini isteme, koşulları varsa silinmesini veya yok edilmesini isteme, bu işlemlerin
        aktarılan taraflara bildirilmesini isteme, otomatik sistemlerle aleyhinize bir sonuç
        çıkmasına itiraz etme ve kanuna aykırı işleme nedeniyle zarara uğrarsanız tazminat isteme
        haklarına sahipsiniz.
      </p>
      <p>
        Hesabınızı Uygulamanın Hesap sayfasından kendiniz silebilirsiniz. Diğer başvurularınızı{' '}
        {COMPANY.email} adresine, kimliğinizi doğrulayacak bilgilerle iletebilirsiniz. Başvurular en
        geç 30 gün içinde sonuçlandırılır.
      </p>
    </LegalPage>
  );
}
