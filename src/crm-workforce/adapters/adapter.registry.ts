import { Injectable } from '@nestjs/common';
import { CrmAdapter } from './crm-adapter';
import {
  ExportImportAdapter,
  FixtureCrmAdapter,
  ManualAssistAdapter,
} from './local.adapters';
import { TekionApiAdapter, TekionBrowserAdapter } from './tekion.adapters';

/** Future CRM providers are added here; nothing else in the workforce names a vendor. */
@Injectable()
export class CrmAdapterRegistry {
  readonly fixture = new FixtureCrmAdapter();
  private readonly adapters: CrmAdapter[] = [
    this.fixture,
    new ExportImportAdapter(),
    new ManualAssistAdapter(),
    new TekionApiAdapter(),
    new TekionBrowserAdapter(),
  ];
  all(): CrmAdapter[] {
    return this.adapters;
  }
  get(key: string): CrmAdapter | null {
    return this.adapters.find((a) => a.key === key) ?? null;
  }
}
