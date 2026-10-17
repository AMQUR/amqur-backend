import { answerDealershipFact } from './dealership-facts';

describe('answerDealershipFact', () => {
  it('does not invent a doc fee when the policy has none', () => {
    const a = answerDealershipFact({
      topic: 'fees',
      knowledge: [],
      docFee: null,
      taxRatePercent: null,
      policyConfigured: false,
    });
    expect(a.en).toMatch(/won't quote/i);
    expect(a.en).not.toMatch(/\$\d/);
  });

  it('states a verified doc fee when the policy has one', () => {
    const a = answerDealershipFact({
      topic: 'fees',
      knowledge: [],
      docFee: 367,
      taxRatePercent: 9.5,
      policyConfigured: true,
    });
    expect(a.en).toMatch(/\$367/);
    expect(a.source).toBe('financial_policy');
  });

  it('lists packages from the vehicle and does not promise they can be declined', () => {
    const a = answerDealershipFact({
      topic: 'packages',
      knowledge: [],
      docFee: null,
      taxRatePercent: null,
      policyConfigured: false,
      vehicleLabel: 'Jeep Compass',
      features: ['tow package', 'apple carplay'],
    });
    expect(a.en).toMatch(/tow package/);
    expect(a.en).toMatch(/won't promise/i);
  });

  it('does not invent reviews or a finance-only price', () => {
    const reviews = answerDealershipFact({
      topic: 'reviews',
      knowledge: [],
      docFee: null,
      taxRatePercent: null,
      policyConfigured: false,
    });
    expect(reviews.en).toMatch(/won't invent/i);
    const price = answerDealershipFact({
      topic: 'price_financing',
      knowledge: [],
      docFee: null,
      taxRatePercent: null,
      policyConfigured: false,
      advertisedPrice: 30980,
    });
    expect(price.en).toMatch(/\$30,980/);
    expect(price.en).toMatch(/won't say a financing-dependent price/i);
  });
});
