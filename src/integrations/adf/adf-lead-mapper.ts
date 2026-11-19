import {
  AdfAppointmentFacts,
  AdfLeadDto,
  AdfVehicle,
  AdfVehicleInterest,
} from './adf.types';

export type MapperLead = {
  id: string;
  createdAt: Date;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  interestedVin: string | null;
  interestedStock: string | null;
  preferredContact: string | null;
  leaseVsPurchase: string | null;
  consentToText: boolean;
  consentToEmail: boolean;
  consentToCall: boolean;
  optOutAt: Date | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  source: string;
  nextBestAction: string | null;
};

/** A vehicle row from THIS tenant's verified inventory, or null when the VIN is not in it. */
export type MapperVehicle = {
  vin: string;
  stock: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  condition: string | null;
} | null;

export type MapperAppointment = {
  type: string;
  status: AdfAppointmentFacts['status'];
  availabilityVerified: boolean;
  requestedDate: string | null;
  requestedTime: string | null;
  scheduledAt: Date | null;
  timezone: string;
} | null;

const ACTIONS: Record<string, string> = {
  SALES: 'Sales inquiry - contact the customer',
  SERVICE: 'Service inquiry - contact the customer',
  PARTS: 'Parts inquiry - contact the customer',
};

function vehicleStatus(condition: string | null): 'new' | 'used' | undefined {
  const c = (condition ?? '').toLowerCase();
  if (c === 'new') return 'new';
  if (c === 'used' || c === 'certified') return 'used';
  return undefined; // unknown stays unknown
}

/** Recorded opt-in → true; a recorded opt-out → false; otherwise "not recorded" (null). */
const consent = (granted: boolean, optedOut: boolean): boolean | null =>
  optedOut ? false : granted ? true : null;

/**
 * Pure mapping from AMQUR rows to the canonical ADF DTO. Vehicle year/make/model/trim are
 * taken ONLY from the tenant's own inventory row for the lead's VIN; if the VIN is not in that
 * inventory only the VIN/stock the customer context actually carried is passed through.
 */
export function mapLeadToAdf(p: {
  lead: MapperLead;
  department: 'SALES' | 'SERVICE' | 'PARTS';
  vendorName: string;
  providerName: string;
  vehicle: MapperVehicle;
  appointment: MapperAppointment;
  /**
   * Per-channel standing resolved from the consent ledger (true / false / not recorded).
   * When omitted the lead's own flags are used.
   */
  consent?: {
    text: boolean | null;
    email: boolean | null;
    call: boolean | null;
  };
}): AdfLeadDto {
  const { lead } = p;
  const interest: AdfVehicleInterest =
    p.appointment?.type === 'TEST_DRIVE'
      ? 'test-drive'
      : (lead.leaseVsPurchase ?? '').toLowerCase() === 'lease'
        ? 'lease'
        : 'buy';
  const vehicles: AdfVehicle[] = [];
  if (p.department === 'SALES') {
    if (p.vehicle) {
      vehicles.push({
        interest,
        status: vehicleStatus(p.vehicle.condition),
        year: p.vehicle.year,
        make: p.vehicle.make,
        model: p.vehicle.model,
        trim: p.vehicle.trim ?? undefined,
        vin: p.vehicle.vin,
        stock: p.vehicle.stock ?? undefined,
      });
    } else if (lead.interestedVin || lead.interestedStock) {
      vehicles.push({
        interest,
        vin: lead.interestedVin ?? undefined,
        stock: lead.interestedStock ?? undefined,
      });
    }
  }
  const a = p.appointment;
  const appointment: AdfAppointmentFacts | null = a
    ? {
        status: a.status,
        availabilityVerified: a.availabilityVerified,
        type: a.type,
        when:
          a.status === 'CONFIRMED' && a.availabilityVerified && a.scheduledAt
            ? `${a.scheduledAt.toISOString()} (${a.timezone})`
            : [a.requestedDate, a.requestedTime].filter(Boolean).join(' ') ||
              undefined,
      }
    : null;
  const optedOut = lead.optOutAt !== null;
  const standing = p.consent ?? {
    text: consent(lead.consentToText, optedOut),
    email: consent(lead.consentToEmail, optedOut),
    call: consent(lead.consentToCall, optedOut),
  };
  return {
    leadRef: `amqur-lead-${lead.id}`,
    idSource: 'AMQUR',
    requestDate: lead.createdAt.toISOString(),
    vehicles,
    customer: {
      firstName: lead.firstName ?? undefined,
      lastName: lead.lastName ?? undefined,
      email: lead.email ?? undefined,
      phone: lead.phone ?? undefined,
      // Never label a number textable when the customer's standing for text is not an opt-in.
      phoneType: standing.text === true ? 'cellphone' : 'voice',
    },
    comments: {
      department: p.department,
      requestedAction: ACTIONS[p.department],
      preferredContact: lead.preferredContact ?? undefined,
      appointment,
      consent: standing,
      source: lead.source,
      utmSource: lead.utmSource ?? undefined,
      utmMedium: lead.utmMedium ?? undefined,
      utmCampaign: lead.utmCampaign ?? undefined,
    },
    vendorName: p.vendorName,
    providerName: p.providerName,
  };
}
