import { CapabilityService } from './capability.service';

describe('CapabilityService fail-closed gates', () => {
  const flags = {
    resolve: jest.fn(),
  };
  const prisma = {
    location: { findFirst: jest.fn() },
    vehicle: { count: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
  };

  const svc = new CapabilityService(prisma as never, flags as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('blocks inventory when flag false', async () => {
    flags.resolve.mockResolvedValue({ inventory: false });
    const r = await svc.check('t1', 'l1', 'inventory');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('inventory_flag_off');
  });

  it('blocks inventory when flag true but no vehicles/source', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.location.findFirst.mockResolvedValue({ inventoryFeedUrl: null });
    prisma.vehicle.count.mockResolvedValue(0);
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
    const r = await svc.check('t1', 'l1', 'inventory');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_inventory_source');
  });

  it('allows inventory when fresh vehicles exist', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.location.findFirst.mockResolvedValue({
      inventoryFeedUrl: 'https://feeds.example.com/x.xml',
    });
    prisma.vehicle.count
      .mockResolvedValueOnce(3) // sellable
      .mockResolvedValueOnce(2); // fresh/degraded
    const r = await svc.check('t1', 'l1', 'inventory');
    expect(r.allowed).toBe(true);
  });

  it('blocks payments when financeCalculator false', async () => {
    flags.resolve.mockResolvedValue({
      payments: true,
      financeCalculator: false,
    });
    const r = await svc.check('t1', 'l1', 'payments');
    expect(r.allowed).toBe(false);
  });

  it('allows chat when flag true', async () => {
    flags.resolve.mockResolvedValue({ chat: true });
    expect((await svc.check('t1', 'l1', 'chat')).allowed).toBe(true);
  });

  it('blocks service and parts when flags off', async () => {
    flags.resolve.mockResolvedValue({ serviceAi: false, partsAi: false });
    expect((await svc.check('t1', 'l1', 'service')).allowed).toBe(false);
    expect((await svc.check('t1', 'l1', 'parts')).allowed).toBe(false);
  });

  it('allows handoff when chat on', async () => {
    flags.resolve.mockResolvedValue({ chat: true });
    expect((await svc.check('t1', 'l1', 'handoff')).allowed).toBe(true);
  });

  it('blocks vehicleCompare when flag off', async () => {
    flags.resolve.mockResolvedValue({ vehicleCompare: false });
    expect((await svc.check('t1', 'l1', 'vehicleCompare')).allowed).toBe(false);
  });

  it('blocks savedVehicles when flag off', async () => {
    flags.resolve.mockResolvedValue({ savedVehicles: false });
    expect((await svc.check('t1', 'l1', 'savedVehicles')).allowed).toBe(false);
  });

  it('blocks inventory when vehicles stale only', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.location.findFirst.mockResolvedValue({
      inventoryFeedUrl: 'https://feeds.example.com/x.xml',
    });
    prisma.vehicle.count.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const r = await svc.check('t1', 'l1', 'inventory');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('inventory_stale');
  });

  it('payments blocked when inventory chain not ready', async () => {
    flags.resolve.mockResolvedValue({
      payments: true,
      financeCalculator: true,
      inventory: true,
    });
    prisma.location.findFirst.mockResolvedValue({ inventoryFeedUrl: null });
    prisma.vehicle.count.mockResolvedValue(0);
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
    const r = await svc.check('t1', 'l1', 'payments');
    expect(r.allowed).toBe(false);
  });

  it('production never counts synthetic demo vehicles as inventory', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      flags.resolve.mockResolvedValue({ inventory: true });
      prisma.location.findFirst.mockResolvedValue({ inventoryFeedUrl: null });
      prisma.vehicle.count.mockResolvedValue(0);
      prisma.integrationConnection.findFirst.mockResolvedValue(null);
      const r = await svc.check('t1', 'l1', 'inventory');
      expect(r.allowed).toBe(false);
      expect(prisma.vehicle.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ NOT: { source: 'synthetic_demo' } }),
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it.each([
    ['appointments', { appointments: false }, 'appointments_flag_off'],
    ['appointments', { appointments: true }, undefined],
    ['leadCapture', { leadCapture: false }, 'lead_capture_off'],
    ['knowledge', { knowledge: false }, 'knowledge_flag_off'],
    ['sms', { sms: false }, 'sms_flag_off'],
    ['savedVehicles', { savedVehicles: false }, 'saved_flag_off'],
    ['handoff', { chat: false }, 'chat_disabled'],
    ['handoff', { chat: true }, undefined],
    ['service', { serviceAi: false }, 'service_flag_off'],
    ['parts', { partsAi: false }, 'parts_flag_off'],
    ['chat', { chat: false }, 'chat_disabled'],
  ])('%s gate with %j → %s', async (cap, f, reason) => {
    flags.resolve.mockResolvedValue(f);
    const r = await svc.check('t1', 'l1', cap as never);
    expect(r.allowed).toBe(reason === undefined);
    if (reason) expect(r.reason).toBe(reason);
  });

  it('inventory with stale vehicles only is blocked as stale', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.location.findFirst.mockResolvedValue({ inventoryFeedUrl: null });
    prisma.vehicle.count.mockResolvedValueOnce(4).mockResolvedValueOnce(0);
    const r = await svc.check('t1', 'l1', 'inventory');
    expect(r.reason).toBe('inventory_stale');
  });
});

describe('CapabilityService expanded gate coverage', () => {
  const flags = { resolve: jest.fn() };
  const prisma = {
    location: { findFirst: jest.fn() },
    vehicle: { count: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
  };
  const service = new CapabilityService(prisma as never, flags as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.location.findFirst.mockResolvedValue(null);
    prisma.vehicle.count.mockResolvedValue(0);
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
  });

  it('blocks chat and handoff when chat is disabled', async () => {
    flags.resolve.mockResolvedValue({ chat: false });
    const chat = await service.check('tenant-a', 'roof-a', 'chat');
    const handoff = await service.check('tenant-a', 'roof-a', 'handoff');
    expect(chat).toMatchObject({ allowed: false, reason: 'chat_disabled' });
    expect(handoff).toMatchObject({ allowed: false, reason: 'chat_disabled' });
  });

  it('allows explicitly enabled service and parts', async () => {
    flags.resolve.mockResolvedValue({ serviceAi: true, partsAi: true });
    const serviceGate = await service.check('tenant-a', 'roof-a', 'service');
    const partsGate = await service.check('tenant-a', 'roof-a', 'parts');
    expect(serviceGate).toEqual({ allowed: true });
    expect(partsGate).toEqual({ allowed: true });
  });

  it.each([
    ['savedVehicles', 'savedVehicles', 'saved_flag_off'],
    ['appointments', 'appointments', 'appointments_flag_off'],
    ['leadCapture', 'leadCapture', 'lead_capture_off'],
    ['knowledge', 'knowledge', 'knowledge_flag_off'],
    ['sms', 'sms', 'sms_flag_off'],
  ] as const)(
    '%s requires an explicit enable flag',
    async (capability, flag, reason) => {
      flags.resolve.mockResolvedValue({ [flag]: false });
      const off = await service.check('tenant-a', 'roof-a', capability);
      expect(off).toMatchObject({ allowed: false, reason });
      flags.resolve.mockResolvedValue({ [flag]: true });
      const on = await service.check('tenant-a', 'roof-a', capability);
      expect(on).toEqual({ allowed: true });
    },
  );

  it('requires verified inventory for payments', async () => {
    flags.resolve.mockResolvedValue({
      payments: true,
      financeCalculator: true,
      inventory: true,
    });
    prisma.vehicle.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    const result = await service.check('tenant-a', 'roof-a', 'payments');
    expect(result).toEqual({ allowed: true });
    expect(prisma.vehicle.count).toHaveBeenCalledTimes(2);
  });

  it('allows comparison after inventory gating succeeds', async () => {
    flags.resolve.mockResolvedValue({ vehicleCompare: true, inventory: true });
    prisma.vehicle.count.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    const result = await service.check('tenant-a', 'roof-a', 'vehicleCompare');
    expect(result).toEqual({ allowed: true });
  });

  it('propagates inventory blockers to comparison', async () => {
    flags.resolve.mockResolvedValue({ vehicleCompare: true, inventory: false });
    const result = await service.check('tenant-a', 'roof-a', 'vehicleCompare');
    expect(result).toMatchObject({
      allowed: false,
      reason: 'inventory_flag_off',
    });
    expect(prisma.vehicle.count).not.toHaveBeenCalled();
  });

  it('reports a configured-but-empty rooftop feed', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.location.findFirst.mockResolvedValue({
      inventoryFeedUrl: 'https://dealer.example/authorized.xml',
    });
    const result = await service.check('tenant-a', 'roof-a', 'inventory');
    expect(result).toMatchObject({
      allowed: false,
      reason: 'feed_configured_but_empty',
    });
    expect(prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
  });

  it('reports a live vAuto connection with no imported vehicles', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.integrationConnection.findFirst.mockResolvedValue({
      id: 'connection-a',
    });
    const result = await service.check('tenant-a', 'roof-a', 'inventory');
    expect(result).toMatchObject({
      allowed: false,
      reason: 'vauto_enabled_but_no_vehicles',
    });
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        provider: 'VAUTO',
        enabled: true,
        liveReady: true,
      },
      select: { id: true },
    });
  });

  it('checks tenant-wide inventory when location is null', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.vehicle.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const result = await service.check('tenant-a', null, 'inventory');
    expect(result).toEqual({ allowed: true });
    expect(prisma.location.findFirst).not.toHaveBeenCalled();
    expect(prisma.vehicle.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
      },
    });
  });

  it('does not count vehicles from another rooftop', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.vehicle.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const result = await service.check('tenant-a', 'roof-a', 'inventory');
    expect(result).toMatchObject({
      allowed: false,
      reason: 'inventory_stale',
    });
    for (const call of prisma.vehicle.count.mock.calls) {
      expect(call[0].where).toMatchObject({
        tenantId: 'tenant-a',
        locationId: 'roof-a',
      });
    }
  });

  it('fails closed for unknown capabilities', async () => {
    flags.resolve.mockResolvedValue({});
    const result = await service.check(
      'tenant-a',
      'roof-a',
      'unsupported' as never,
    );
    expect(result).toMatchObject({ allowed: false, reason: 'unknown' });
  });
});
