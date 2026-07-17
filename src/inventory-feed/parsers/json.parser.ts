export class JsonInventoryParser {
  static parse(data: any) {
    return data.vehicles || [];
  }
}
