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

  it('rejects chat and human handoff when chat is disabled', async () => {
    flags.resolve.mockResolvedValue({ chat: false });
    expect(await service.check('tenant-a', 'roof-a', 'chat')).toMatchObject({
      allowed: false,
      reason: 'chat_disabled',
    });
    expect(await service.check('tenant-a', 'roof-a', 'handoff')).toMatchObject({
      allowed: false,
      reason: 'chat_disabled',
    });
  });

  it('permits service and parts assistance when explicitly enabled', async () => {
    flags.resolve.mockResolvedValue({ serviceAi: true, partsAi: true });
    expect(await service.check('tenant-a', 'roof-a', 'service')).toEqual({ allowed: true });
    expect(await service.check('tenant-a', 'roof-a', 'parts')).toEqual({ allowed: true });
  });

  it.each([
    ['savedVehicles', 'savedVehicles', 'saved_flag_off'],
    ['appointments', 'appointments', 'appointments_flag_off'],
    ['leadCapture', 'leadCapture', 'lead_capture_off'],
    ['knowledge', 'knowledge', 'knowledge_flag_off'],
    ['sms', 'sms', 'sms_flag_off'],
  ] as const)(
    '%s is disabled without explicit permission and enabled with it',
    async (capability, flag, reason) => {
      flags.resolve.mockResolvedValue({ [flag]: false });
      expect(await service.check('tenant-a', 'roof-a', capability)).toMatchObject({
        allowed: false,
        reason,
      });
      flags.resolve.mockResolvedValue({ [flag]: true });
      expect(await service.check('tenant-a', 'roof-a', capability)).toEqual({
        allowed: true,
      });
    },
  );

  it('allows a payment estimate only when pricing inventory and both flags are ready', async () => {
    flags.resolve.mockResolvedValue({
      payments: true,
      financeCalculator: true,
      inventory: true,
    });
    prisma.vehicle.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    expect(await service.check('tenant-a', 'roof-a', 'payments')).toEqual({
      allowed: true,
    });
    expect(prisma.vehicle.count).toHaveBeenCalledTimes(2);
  });

  it('permits compare only after successfully checking the inventory dependency', async () => {
    flags.resolve.mockResolvedValue({ vehicleCompare: true, inventory: true });
    prisma.vehicle.count.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    expect(await service.check('tenant-a', 'roof-a', 'vehicleCompare')).toEqual({
      allowed: true,
    });
  });

  it('propagates an inventory dependency rejection for vehicle compare', async () => {
    flags.resolve.mockResolvedValue({ vehicleCompare: true, inventory: false });
    expect(await service.check('tenant-a', 'roof-a', 'vehicleCompare')).toMatchObject({
      allowed: false,
      reason: 'inventory_flag_off',
    });
    expect(prisma.vehicle.count).not.toHaveBeenCalled();
  });

  it('distinguishes configured-but-empty rooftop feed from no inventory source', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.location.findFirst.mockResolvedValue({
      inventoryFeedUrl: 'https://dealer.example/authorized.xml',
    });
    expect(await service.check('tenant-a', 'roof-a', 'inventory')).toMatchObject({
      allowed: false,
      reason: 'feed_configured_but_empty',
    });
    expect(prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
  });

  it('reports a configured live vAuto connection with no imported vehicles', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.integrationConnection.findFirst.mockResolvedValue({ id: 'connection-a' });
    expect(await service.check('tenant-a', 'roof-a', 'inventory')).toMatchObject({
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

  it('checks tenant-wide inventory without querying a location when location is null', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.vehicle.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    expect(await service.check('tenant-a', null, 'inventory')).toEqual({ allowed: true });
    expect(prisma.location.findFirst).not.toHaveBeenCalled();
    expect(prisma.vehicle.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
      },
    });
  });

  it('does not count fresh units from the wrong rooftop toward availability', async () => {
    flags.resolve.mockResolvedValue({ inventory: true });
    prisma.vehicle.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await service.check('tenant-a', 'roof-a', 'inventory')).toMatchObject({
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

  it('fails closed for an unsupported capability name', async () => {
    flags.resolve.mockResolvedValue({});
    expect(await service.check('tenant-a', 'roof-a', 'unsupported' as never)).toMatchObject({
      allowed: false,
      reason: 'unknown',
    });
  });
});
