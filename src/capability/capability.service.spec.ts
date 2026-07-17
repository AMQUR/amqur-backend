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
