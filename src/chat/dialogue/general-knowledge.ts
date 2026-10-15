/**
 * General automotive explanations that are true at any dealership — used when no language
 * model is available, so common "what's the difference…" questions get a real answer instead
 * of "that's not in the dealership's information". Never contains store-specific facts
 * (prices, fees, rates, policies, availability). When a model is available it answers these
 * itself under the same rule.
 */
type Entry = { re: RegExp; en: string; es: string };

const ENTRIES: Entry[] = [
  {
    re: /\bwhat(?:'s| is| does)\b.*\b(awd|all[- ]wheel drive)\b|\b(awd)\b.*\bmean\b/,
    en: 'AWD (all-wheel drive) sends power to all four wheels automatically whenever the system senses slip, so you get extra grip on wet or snowy roads without doing anything. It’s different from 4x4, which you usually switch on yourself and is built more for off-road and deep snow.',
    es: 'AWD (tracción integral) manda fuerza a las cuatro ruedas automáticamente cuando detecta que patinan, así tiene más agarre en lluvia o nieve sin hacer nada. Es distinto del 4x4, que normalmente activa usted y está hecho más para terreno difícil y nieve profunda.',
  },
  {
    re: /\b(?:good|any good|okay|great|reliable) (?:in|for) (?:the )?(?:snow|winter|winters|ice|chicago)\b/,
    en: 'Generally, yes — a 4x4 Jeep with good winter or all-season tires handles Chicago snow well, and ground clearance helps with unplowed streets. The tires matter as much as the drivetrain, and 4x4 helps you get going but doesn’t help you stop, so braking distances still grow on ice.',
    es: 'En general, sí — un Jeep 4x4 con buenas llantas de invierno o para toda temporada se maneja bien en la nieve de Chicago, y la altura ayuda en calles sin limpiar. Las llantas importan tanto como la tracción, y el 4x4 ayuda a arrancar pero no a frenar.',
  },
  {
    re: /\b(check engine|engine light|warning light)\b/,
    en: 'In general, a steady check-engine light means the car has logged a fault worth having read soon — it can be as simple as a loose gas cap. A flashing light usually means a misfire that can damage the catalytic converter, so it’s best to ease off and have it checked right away. Only a technician reading the code can say what it is.',
    es: 'En general, una luz de “check engine” fija indica una falla registrada que conviene revisar pronto — puede ser algo tan simple como el tapón de gasolina. Si parpadea, suele ser una falla de encendido que puede dañar el catalizador, así que conviene revisarlo cuanto antes. Solo un técnico leyendo el código puede decir qué es.',
  },
  {
    re: /\b(awd|all[- ]wheel)\b.*\b(4wd|4x4|four[- ]wheel)\b|\b(4wd|4x4|four[- ]wheel)\b.*\b(awd|all[- ]wheel)\b/,
    en: 'Generally, all-wheel drive is always on and automatically shifts power between wheels — great for rain and snow on pavement. Four-wheel drive (4x4) is usually driver-selected and built tougher, with low-range gearing for off-road, deep snow or towing out of tough spots.',
    es: 'En general, la tracción integral (AWD) siempre está activa y reparte la fuerza automáticamente — ideal para lluvia y nieve en pavimento. La 4x4 normalmente la activa el conductor y es más robusta, con baja para terreno difícil, nieve profunda o remolque.',
  },
  {
    re: /\blease\b.*\b(financ\w*|buy|loan)\b|\b(financ\w*|buy|loan)\b.*\blease\b/,
    en: 'In general: leasing means lower monthly payments to use the vehicle for a set term and mileage, then you return it (or buy it out). Financing means higher payments, but you own it at the end with no mileage limits. The right choice depends on how much you drive and how long you keep vehicles.',
    es: 'En general: con arrendamiento paga menos al mes por usar el vehículo un plazo y millaje fijos, y luego lo devuelve (o lo compra). Con financiamiento paga más al mes, pero al final es suyo y sin límite de millas. Depende de cuánto maneja y cuánto tiempo conserva sus autos.',
  },
  {
    re: /\b(hybrid|plug[- ]in|phev|ev|electric)\b.*\b(hybrid|plug[- ]in|phev|ev|electric|gas)\b/,
    en: 'Generally: a hybrid charges itself and just uses less gas; a plug-in hybrid adds a bigger battery you charge for a stretch of electric-only driving, then runs on gas; a full EV runs only on electricity and needs charging.',
    es: 'En general: el híbrido se carga solo y gasta menos gasolina; el híbrido enchufable tiene una batería mayor que se carga para recorrer un tramo solo eléctrico y luego usa gasolina; el eléctrico funciona solo con electricidad y necesita cargarse.',
  },
  {
    re: /\bwhat(?:'s| is| does)\b.*\b(out[- ]the[- ]door|otd)\b.*\b(mean|include)/,
    en: 'Out-the-door is the total you’d actually pay: the vehicle price plus sales tax, the dealer’s documentation fee and any other dealer charges, and title/registration fees — minus any trade-in or rebates that apply.',
    es: 'El precio final (“out-the-door”) es el total real: precio del vehículo más impuestos, cargo de documentación y otros cargos de la agencia, y título/registro — menos el valor de su auto a cuenta o reembolsos que apliquen.',
  },
  {
    re: /\b(doc(?:umentation)? fee)\b.*\b(what|mean|is)\b|\bwhat(?:'s| is) (?:a |the )?doc(?:umentation)? fee\b/,
    en: 'A documentation fee is what a dealership charges to prepare and file the sale and title paperwork. The amount varies by dealer and state — the team can tell you this store’s exact fee.',
    es: 'El cargo de documentación es lo que cobra la agencia por preparar y tramitar los papeles de la venta y el título. Varía según la agencia y el estado — el equipo le confirma el monto exacto.',
  },
  {
    re: /\bwhat(?:'s| is| does)\b.*\bapr\b|\bapr\b.*\bmean\b/,
    en: 'APR is the yearly cost of the loan, including interest and certain fees, as a percentage. Your actual APR depends on the lender, your credit and the term — it’s only known after a credit application.',
    es: 'El APR es el costo anual del préstamo, con intereses y ciertos cargos, en porcentaje. Su APR real depende del prestamista, su crédito y el plazo — solo se sabe después de una solicitud de crédito.',
  },
  {
    re: /\bgap (?:insurance|coverage)\b/,
    en: 'GAP coverage pays the difference between what you owe on the loan and what insurance pays if the vehicle is totaled or stolen. It’s most useful with a small down payment or a long loan.',
    es: 'La cobertura GAP paga la diferencia entre lo que debe del préstamo y lo que paga el seguro si el vehículo es pérdida total o robado. Sirve más con poco enganche o plazos largos.',
  },
  {
    re: /\b(cpo|certified pre[- ]?owned)\b/,
    en: 'Certified pre-owned means a used vehicle that passed the manufacturer’s inspection program and usually comes with extended factory warranty coverage. The exact coverage depends on the brand’s program.',
    es: 'Seminuevo certificado (CPO) es un usado que pasó la inspección del programa del fabricante y normalmente incluye garantía de fábrica extendida. La cobertura exacta depende del programa de la marca.',
  },
  {
    re: /\bmsrp\b.*\binvoice\b|\binvoice\b.*\bmsrp\b|\bwhat(?:'s| is| does)\b.*\bmsrp\b/,
    en: 'MSRP is the manufacturer’s suggested retail price — the sticker price. Invoice is roughly what the dealer paid the manufacturer, before any dealer incentives. The advertised price can be above or below MSRP.',
    es: 'El MSRP es el precio sugerido por el fabricante — el de la etiqueta. La factura (invoice) es aproximadamente lo que pagó la agencia al fabricante, antes de incentivos. El precio anunciado puede estar por encima o por debajo del MSRP.',
  },
];

export function generalAnswer(
  message: string,
  lang: 'en' | 'es',
): string | null {
  const t = message.toLowerCase();
  const hit = ENTRIES.find((e) => e.re.test(t));
  return hit ? hit[lang] : null;
}
