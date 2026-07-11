# Source of truth

AMQUR orchestrates conversations. External systems own domain facts.

| Field | Primary | Fallback |
|---|---|---|
| advertised_price | vauto | none |
| inventory_availability | vauto | none |
| service_appointment_status | tekion | none |
| repair_order_status | tekion | none |
| customer_contact | tekion | amqur_lead |
| conversation_state | amqur | — |
| payment_estimate | amqur_calculator | — |

Conflicts are recorded in `SourceConflict` and never silently merged.
