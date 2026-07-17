import { Injectable } from '@nestjs/common';

@Injectable()
export class FilterExtractor {
  extract(text: string) {
    const message = text.toLowerCase();

    const filters: any = {};

    // colors
    if (message.includes('black')) filters.color = 'black';
    if (message.includes('white')) filters.color = 'white';
    if (message.includes('silver')) filters.color = 'silver';
    if (message.includes('gray') || message.includes('grey'))
      filters.color = 'gray';
    if (message.includes('red')) filters.color = 'red';
    if (message.includes('blue')) filters.color = 'blue';

    // drivetrain
    if (message.includes('awd') || message.includes('all wheel')) {
      filters.drivetrain = 'AWD';
    }

    if (message.includes('4x4')) {
      filters.drivetrain = '4x4';
    }

    // body types
    if (message.includes('suv')) filters.bodyType = 'SUV';
    if (message.includes('truck')) filters.bodyType = 'Truck';
    if (message.includes('sedan')) filters.bodyType = 'Sedan';

    // doors
    if (message.includes('4 door') || message.includes('four door')) {
      filters.doors = 4;
    }

    if (message.includes('2 door') || message.includes('two door')) {
      filters.doors = 2;
    }

    // price
    const priceMatch = message.match(/under\s?\$?(\d{2,6})/);
    if (priceMatch) {
      filters.maxPrice = Number(priceMatch[1]);
    }

    // monthly payment
    const monthlyMatch = message.match(/\$?(\d{2,4})\s?(?:per|\/)?\s?month/);
    if (monthlyMatch) {
      filters.maxMonthlyPayment = Number(monthlyMatch[1]);
    }

    // sorting
    if (message.includes('cheap') || message.includes('low to high')) {
      filters.sortBy = 'price_asc';
    }

    if (message.includes('high to low')) {
      filters.sortBy = 'price_desc';
    }

    return filters;
  }
}
