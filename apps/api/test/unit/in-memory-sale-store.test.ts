import { describeSaleStoreContract } from '../contracts/sale-store-contract';
import { InMemorySaleStore } from '../fakes/in-memory-sale-store';

describeSaleStoreContract('InMemorySaleStore', ({ sale, paused }) =>
  Promise.resolve(new InMemorySaleStore(sale, paused)),
);
