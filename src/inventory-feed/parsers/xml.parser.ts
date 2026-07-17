import { XMLParser } from 'fast-xml-parser';

export class XmlInventoryParser {
  static parse(xml: string) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    });

    const json = parser.parse(xml);

    return json?.inventory?.vehicle || [];
  }
}
