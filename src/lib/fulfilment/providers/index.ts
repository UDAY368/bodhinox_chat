// The courier registry (store Phase 5): the one place that maps a provider id to its adapter.
import { delhiveryProvider } from './delhivery';
import { shipwayProvider } from './shipway';
import { shiprocketProvider } from './shiprocket';
import { COURIER_PROVIDER_IDS, type CourierProvider, type CourierProviderId } from './types';

const PROVIDERS: Readonly<Record<CourierProviderId, CourierProvider>> = {
  shiprocket: shiprocketProvider,
  delhivery: delhiveryProvider,
  shipway: shipwayProvider,
};

/** The adapter for a provider id (a shipment row's `provider` column). Unknown ids fall back to Shiprocket, the only provider before Phase 5. */
export function getCourierProvider(id: string | null | undefined): CourierProvider {
  return (COURIER_PROVIDER_IDS as readonly string[]).includes(id ?? '') ? PROVIDERS[id as CourierProviderId] : shiprocketProvider;
}

export const allCourierProviders = (): CourierProvider[] => COURIER_PROVIDER_IDS.map((id) => PROVIDERS[id]);
export * from './types';
