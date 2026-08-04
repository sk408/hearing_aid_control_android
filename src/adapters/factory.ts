/**
 * Adapter factory — maps detected brand to the correct HearingAidAdapter.
 */
import type { Brand } from '../ble/types';
import type { HearingAidAdapter } from './types';
import { PhilipsAdapter } from './philipsAdapter';
import { RextonAdapter } from './rextonAdapter';
import { StarkeyAdapter } from './starkeyAdapter';
import { ResoundAdapter } from './resoundAdapter';
import { MfiAdapter } from './mfiAdapter';

export function createAdapter(brand: Brand): HearingAidAdapter | null {
  switch (brand) {
    case 'philips':
      return new PhilipsAdapter();
    case 'rexton':
      return new RextonAdapter();
    case 'starkey':
      return new StarkeyAdapter();
    case 'resound':
      return new ResoundAdapter();
    case 'mfi':
      return new MfiAdapter();
    case 'unknown':
      return null;
  }
}
