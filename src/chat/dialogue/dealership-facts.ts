/**
 * Answers that can be given from records the store has already verified:
 * knowledge-base text, the financial policy, the selected vehicle's listed
 * features, and store hours. If none of those contain the fact, the reply
 * says so and names a next step. It does not invent fees, reviews, or rules.
 */

export type PolicyTopic =
  | 'fees'
  | 'packages'
  | 'walk_in'
  | 'reviews'
  | 'price_financing'
  | 'cash_vs_finance'
  | 'otd_meaning';

export type FactAnswer = { en: string; es: string; source: string };

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

export function answerDealershipFact(input: {
  topic: PolicyTopic;
  knowledge: Array<{ title: string; content: string }>;
  docFee: number | null;
  taxRatePercent: number | null;
  policyConfigured: boolean;
  features?: string[];
  vehicleLabel?: string;
  hoursSummary?: string | null;
  advertisedPrice?: number | null;
}): FactAnswer {
  const kb = input.knowledge
    .map((h) => `${h.title}: ${h.content}`.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  const kbBit = kb
    ? ` The dealership's published note says: ${kb.slice(0, 500)}`
    : '';

  switch (input.topic) {
    case 'fees': {
      if (input.policyConfigured && input.docFee != null) {
        return {
          source: 'financial_policy',
          en: `The verified documentation fee on file is ${money(input.docFee)}.${input.taxRatePercent != null ? ` The verified tax rate on file is ${input.taxRatePercent}%.` : ''} Other government fees are included only when that same policy lists them.`,
          es: `El cargo de documentación verificado es ${money(input.docFee)}.${input.taxRatePercent != null ? ` La tasa de impuesto verificada es ${input.taxRatePercent}%.` : ''}`,
        };
      }
      return {
        source: kb ? 'knowledge_base' : 'financial_policy',
        en: `I don't have a verified documentation fee or tax amount for this store, so I won't quote one.${kbBit} I can put a written out-the-door request in for the sales team to fill in the fees.`,
        es: `No tengo un cargo de documentación ni un impuesto verificado de esta agencia, así que no voy a inventar una cifra.${kb ? ' Hay una nota publicada de la agencia.' : ''} Puedo dejar una solicitud de precio final para que el equipo complete los cargos.`,
      };
    }
    case 'packages': {
      const listed = input.features?.filter(Boolean).slice(0, 8) ?? [];
      const vehicle = input.vehicleLabel ?? 'this vehicle';
      const list = listed.length
        ? `The listing for the ${vehicle} includes: ${listed.join(', ')}.`
        : `I don't have a package list on the ${vehicle}.`;
      const decline =
        /\b(?:can be declined|may be removed|optional and removable|customer may decline)\b/i.test(
          kb,
        );
      return {
        source: listed.length ? 'inventory' : kb ? 'knowledge_base' : 'none',
        en: `${list}${kbBit} ${
          decline
            ? 'The dealership note above is the only basis for whether something can be removed.'
            : "I don't have a verified policy that optional packages can be declined or removed, so I won't promise that."
        } The sales team can confirm what's included and what can change.`,
        es: `${listed.length ? `El anuncio incluye: ${listed.join(', ')}.` : 'No tengo la lista de paquetes.'} No voy a prometer que un paquete se puede quitar si la agencia no lo tiene verificado. El equipo de ventas lo confirma.`,
      };
    }
    case 'walk_in': {
      const hours = input.hoursSummary
        ? `Verified hours: ${input.hoursSummary}`
        : "I don't have verified hours for this location.";
      return {
        source: input.hoursSummary
          ? 'store_hours'
          : kb
            ? 'knowledge_base'
            : 'none',
        en: `${hours}.${kbBit} Walk-ins aren't something I can promise without an appointment — I can record a visit request and the team confirms it.`,
        es: `${input.hoursSummary ? `Horario verificado: ${input.hoursSummary}.` : 'No tengo horario verificado.'} No tengo una política verificada de visitas sin cita, así que no puedo prometer que lo atiendan sin cita. Puedo registrar una solicitud y el equipo la confirma.`,
      };
    }
    case 'reviews':
      return {
        source: kb ? 'knowledge_base' : 'none',
        en: kb
          ? `Here's the review information the dealership has published: ${kb.slice(0, 500)} I won't add ratings that aren't in that note.`
          : "I don't have this dealership's verified reviews in what I can access, so I won't invent a star rating or quote a review. The store's own website is the place for that, or I can have someone from the team follow up.",
        es: kb
          ? 'Puedo compartir solo lo que la agencia publicó sobre reseñas, sin agregar calificaciones.'
          : 'No tengo reseñas verificadas de esta agencia, así que no voy a inventar una calificación. El sitio de la agencia las tiene, o alguien del equipo le puede dar seguimiento.',
      };
    case 'price_financing':
      return {
        source: kb ? 'knowledge_base' : 'inventory',
        en: `${
          input.advertisedPrice
            ? `The advertised price I can show is ${money(input.advertisedPrice)}. `
            : ''
        }${
          /\b(?:requires financing|finance only|must finance|with approved credit only)\b/i.test(
            kb,
          )
            ? `The dealership's note says: ${kb.slice(0, 400)}`
            : "I won't say a financing-dependent price applies here — I don't have a verified rule that this price requires financing. The sales team confirms the written terms."
        }`,
        es: 'No tengo una regla verificada de que el precio anunciado exija financiamiento. No voy a decir que un precio condicionado al crédito aplica a una compra de contado. El equipo confirma los términos por escrito.',
      };
    case 'cash_vs_finance':
      return {
        source: kb ? 'knowledge_base' : 'none',
        en: /\b(?:cash not accepted|no cash|finance required)\b/i.test(kb)
          ? `The dealership's note says: ${kb.slice(0, 400)}`
          : "I don't have a verified restriction against paying cash. You can ask for a cash purchase or for financing, and the team confirms what this vehicle allows. I won't treat a finance-only price as the cash price.",
        es: 'No tengo una restricción verificada contra pagar de contado. Puede pedir compra de contado o financiamiento, y el equipo confirma qué permite este vehículo.',
      };
    case 'otd_meaning':
      return {
        source: 'general_automotive_knowledge',
        en: `Out-the-door means the amount you would pay to drive away: the vehicle price plus sales tax, the dealership's documentation fee, and title and registration fees, minus a trade or rebate when one applies. ${
          input.policyConfigured
            ? 'This store has verified tax and fee rules, so I can itemize a preliminary estimate.'
            : "This store has not verified those tax and fee amounts here, so I won't guess the total — I can save a written-quote request for the team."
        }`,
        es: 'El precio final es el precio del vehículo más impuestos, cargo de documentación y título y registro. Si la agencia no verificó esos montos, no adivino el total y dejo una solicitud para el equipo.',
      };
  }
}
