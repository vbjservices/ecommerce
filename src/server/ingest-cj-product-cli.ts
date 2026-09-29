import './only';
import { ConfigurationError } from '../config/validation';
import { ingestSupplierProduct } from '../application/services/ingest-supplier-product';
import { readCjConfig, readServerConfig } from './config';
import { createPrivilegedDatabase } from './db/supabase';
import { SupabaseSupplierIngestionRepository } from './ingestion/supabase-supplier-ingestion-repository';
import { CjSupplierAdapter } from './integrations/suppliers/cj/adapter';
import { CjClient } from './integrations/suppliers/cj/client';

function productId(input: string | undefined) {
  if (!input) throw new ConfigurationError('Pass a CJ product ID or product URL.');
  const fromUrl = input.match(/-p-([A-Za-z0-9-]+)\.html(?:[?#].*)?$/)?.[1];
  const value = fromUrl ?? input;
  if (!/^[A-Za-z0-9-]{1,200}$/.test(value)) {
    throw new ConfigurationError('The CJ product reference is not valid.');
  }
  return value;
}

try {
  const id = productId(process.argv[2]);
  const serverConfig = readServerConfig(process.env);
  const cjConfig = readCjConfig(process.env);
  const adapter = new CjSupplierAdapter(new CjClient(cjConfig.apiKey));
  const repository = new SupabaseSupplierIngestionRepository(
    createPrivilegedDatabase(serverConfig),
  );
  const result = await ingestSupplierProduct(adapter, repository, id);
  console.log(
    `${result.created ? 'Imported' : 'Updated'} CJ product ${id}: ` +
    `${result.variantCount} variants, candidate ${result.candidateId}.`,
  );
} catch (error) {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : 'CJ product ingestion failed. Check provider access, the migration, and server configuration.',
  );
  process.exitCode = 1;
}
