/**
 * The dealership workforce: eighteen responsibilities, one coordinated system.
 *
 * These are roles, not eighteen model loops. Most are deterministic code; only the ones marked
 * `model` call the language model, and only when a message has to be written. `source` names
 * where each role's work is recorded, so the Command Center can show real workload — or say
 * plainly that nothing has been recorded yet.
 */
export type RosterEntry = {
  key: string;
  name: string;
  scope: 'GROUP' | 'STORE';
  responsibility: string;
  /** deterministic: rules and queries. model: writes customer text through the model gateway. */
  runsOn: 'deterministic' | 'model';
  /** Which recorded work belongs to this role. */
  source:
    | {
        type: 'tasks';
        agentKeys?: string[];
        workflows?: string[];
        departments?: string[];
      }
    | { type: 'workItems'; kinds: string[] }
    | { type: 'mining'; queues: string[] }
    | { type: 'audit'; prefix: string }
    | { type: 'director' }
    | { type: 'health' };
  /** What this role may never do on its own. */
  limits: string;
};

export const ROSTER: RosterEntry[] = [
  {
    key: 'group_operations_director',
    name: 'Group AI Operations Director',
    scope: 'GROUP',
    runsOn: 'deterministic',
    source: { type: 'director' },
    responsibility:
      'Watches all rooftops for unanswered customers, backlogs, connection problems, unusual opt-outs and cost; produces internal recommendations.',
    limits: 'Cannot change a rooftop’s permissions or start a campaign.',
  },
  {
    key: 'group_bdc_supervisor',
    name: 'Group BDC Supervisor',
    scope: 'GROUP',
    runsOn: 'deterministic',
    source: { type: 'audit', prefix: 'crmwf.' },
    responsibility:
      'Enforces the order of checks for every task: store, flag, kill switches, human owner, opt-outs, mode, compliance.',
    limits: 'Cannot be overridden by any agent or by message content.',
  },
  {
    key: 'store_bdc_manager',
    name: 'Store BDC Manager',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: { type: 'tasks' },
    responsibility:
      'Runs this rooftop’s queue: priority order, one task per customer, duplicates and superseded work removed.',
    limits: 'Works only this rooftop’s records.',
  },
  {
    key: 'sales_bdc',
    name: 'Sales BDC Agent',
    scope: 'STORE',
    runsOn: 'model',
    source: { type: 'tasks', agentKeys: ['sales_bdc'] },
    responsibility:
      'Drafts sales replies: availability questions, visit offers, post-visit follow-up.',
    limits:
      'No price, payment, approval or trade value without a verified source; negotiation goes to a person.',
  },
  {
    key: 'service_bdc',
    name: 'Service BDC Agent',
    scope: 'STORE',
    runsOn: 'model',
    source: { type: 'tasks', agentKeys: ['service_bdc'] },
    responsibility: 'Drafts service replies and routes requests to advisors.',
    limits:
      'No diagnosis, estimate or safety assurance; safety concerns go to a person immediately.',
  },
  {
    key: 'parts_bdc',
    name: 'Parts BDC Agent',
    scope: 'STORE',
    runsOn: 'model',
    source: { type: 'tasks', agentKeys: ['parts_bdc'] },
    responsibility: 'Drafts parts replies and arranges counter callbacks.',
    limits: 'No fitment, stock, price or arrival promise; never orders parts.',
  },
  {
    key: 'new_lead_response',
    name: 'New Lead Response Agent',
    scope: 'STORE',
    runsOn: 'model',
    source: { type: 'tasks', workflows: ['first_response'] },
    responsibility: 'First response to new leads.',
    limits:
      'Needs a consent record; without one the lead goes to consent review.',
  },
  {
    key: 'inbound_conversation',
    name: 'Inbound Conversation Agent',
    scope: 'STORE',
    runsOn: 'model',
    source: { type: 'tasks', workflows: ['reply_inbound', 'purchase_intent'] },
    responsibility:
      'Answers customers who wrote in, using the whole conversation.',
    limits:
      'Stops for a human owner, an opt-out, or anything outside verified facts.',
  },
  {
    key: 'appointment',
    name: 'Appointment Agent',
    scope: 'STORE',
    runsOn: 'model',
    source: {
      type: 'workItems',
      kinds: [
        'APPOINTMENT_REQUEST',
        'APPOINTMENT_RESCHEDULE',
        'APPOINTMENT_CANCEL',
        'APPOINTMENT_CONFIRM',
      ],
    },
    responsibility:
      'Turns visit times into requests for staff; checks verified hours.',
    limits: 'Cannot book. A request is never called confirmed.',
  },
  {
    key: 'unsold_showroom_recovery',
    name: 'Unsold Showroom Recovery Agent',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: {
      type: 'mining',
      queues: ['visited_unsold', 'missed_appointments'],
    },
    responsibility:
      'Finds customers who visited or missed an appointment and are still open.',
    limits:
      'Finds and queues; contact follows the same consent and approval rules.',
  },
  {
    key: 'historical_lead_mining',
    name: 'Historical Lead Mining Agent',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: {
      type: 'mining',
      queues: [
        'age_30',
        'age_60',
        'age_90',
        'age_120',
        'age_180',
        'age_365',
        'lost',
        'went_cold',
      ],
    },
    responsibility: 'Segments older leads by age, engagement and status.',
    limits:
      'An old lead is not permission to contact; no consent record means review, not outreach.',
  },
  {
    key: 'customer_retention',
    name: 'Customer Retention Agent',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: { type: 'mining', queues: ['service'] },
    responsibility: 'Surfaces open service opportunities for advisors.',
    limits: 'Does not read service history; never recommends work.',
  },
  {
    key: 'inventory_matching',
    name: 'Inventory Matching Agent',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: { type: 'health' },
    responsibility:
      'Checks the vehicle of interest and same-model alternatives against this rooftop’s fresh inventory feed.',
    limits: 'Stale or missing feed means no availability statement at all.',
  },
  {
    key: 'salesperson_support',
    name: 'Salesperson Support Agent',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: {
      type: 'workItems',
      kinds: ['QUALIFIED_BUYER', 'FOLLOW_UP', 'CRM_NOTE'],
    },
    responsibility:
      'Hot-lead alerts, follow-up reminders, notes for the CRM, assignment recommendations.',
    limits: 'Recommends; never changes who owns a customer.',
  },
  {
    key: 'customer_experience',
    name: 'Customer Experience Agent',
    scope: 'STORE',
    runsOn: 'deterministic',
    source: { type: 'workItems', kinds: ['ESCALATION'] },
    responsibility:
      'Routes complaints, legal, safety, finance and “talk to a person” to the right department.',
    limits: 'Never answers these itself.',
  },
  {
    key: 'compliance_supervisor',
    name: 'Compliance Supervisor',
    scope: 'GROUP',
    runsOn: 'deterministic',
    source: { type: 'audit', prefix: 'crmwf.compliance' },
    responsibility:
      'Consent, suppression, contact hours, limits and policy approval — checked at draft and again at send.',
    limits: 'Runs outside the model; unknown eligibility means no send.',
  },
  {
    key: 'quality_assurance',
    name: 'Quality Assurance Agent',
    scope: 'GROUP',
    runsOn: 'deterministic',
    source: { type: 'audit', prefix: 'crmwf.escalated' },
    responsibility:
      'Checks every draft for length, tone, disclosure and unsourced claims; collects manager reviews.',
    limits: 'A draft that fails twice goes to a person.',
  },
  {
    key: 'infrastructure_monitoring',
    name: 'Infrastructure Monitoring Agent',
    scope: 'GROUP',
    runsOn: 'deterministic',
    source: { type: 'health' },
    responsibility:
      'Worker heartbeats, connector health, dead-lettered work, uncertain sends.',
    limits: 'Reports and stops; does not restart sends.',
  },
];
