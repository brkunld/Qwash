import { kurusToPrice, priceToKurus, signaturePrice } from './money-format';

describe('Iyzico tutar bicimi', () => {
  it('kurusu ondalik TL metnine cevirir', () => {
    expect(kurusToPrice(5000)).toBe('50');
    expect(kurusToPrice(5050)).toBe('50.5');
    expect(kurusToPrice(5005)).toBe('50.05');
    expect(kurusToPrice(1)).toBe('0.01');
  });

  it('TL degerini kurusa cevirir; float hatasi olmaz', () => {
    expect(priceToKurus('50')).toBe(5000);
    expect(priceToKurus('50.50')).toBe(5050);
    expect(priceToKurus(50.5)).toBe(5050);
    expect(priceToKurus(0.29)).toBe(29);
    expect(priceToKurus(1.1)).toBe(110);
  });

  it('gecersiz veya kurustan hassas tutari reddeder', () => {
    expect(() => priceToKurus('abc')).toThrow();
    expect(() => priceToKurus('-5')).toThrow();
    expect(() => priceToKurus('1.005')).toThrow();
  });

  it('imza bicimi sondaki sifirlari atar', () => {
    expect(signaturePrice('50.00')).toBe('50');
    expect(signaturePrice(50.1)).toBe('50.1');
  });
});
