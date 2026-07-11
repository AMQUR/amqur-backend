/** Provider-neutral DMS / service / deal reads. */
export type RepairOrderStatus = {
  externalId: string;
  status: string;
  vehicleVin?: string | null;
  customerVisibleNotes?: string | null;
  readyForPickup?: boolean;
  verified: boolean;
  source: string;
  asOf: string;
};

export type ServiceAppointmentRequest = {
  tenantId: string;
  locationId?: string | null;
  vin?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  preferredDate?: string | null;
  preferredTime?: string | null;
  concern?: string | null;
  idempotencyKey: string;
};

export type ServiceAppointmentResult = {
  externalId?: string | null;
  status: 'REQUESTED' | 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'FAILED';
  confirmed: boolean;
  message: string;
  provider: string;
};

export interface DmsProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  getRepairOrderStatus(params: {
    tenantId: string;
    externalId?: string;
    vin?: string;
  }): Promise<RepairOrderStatus | null>;
  requestServiceAppointment(
    params: ServiceAppointmentRequest,
  ): Promise<ServiceAppointmentResult>;
  getCustomerVehicles?(params: {
    tenantId: string;
    externalCustomerId: string;
  }): Promise<Array<{ vin: string; year?: number; make?: string; model?: string }>>;
}
