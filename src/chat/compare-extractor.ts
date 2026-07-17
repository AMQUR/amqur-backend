export class CompareExtractor {
  extract(text: string, visibleVins: string[]) {
    const lower = text.toLowerCase();

    const vins: string[] = [];

    if (lower.includes('first')) vins.push(visibleVins[0]);
    if (lower.includes('second')) vins.push(visibleVins[1]);
    if (lower.includes('third')) vins.push(visibleVins[2]);

    if (lower.includes('compare all')) {
      return visibleVins.slice(0, 3);
    }

    return vins.filter(Boolean);
  }
}
