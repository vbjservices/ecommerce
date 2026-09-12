import './only';
import { ConfigurationError } from '../config/validation';
import { readServerConfig } from './config';
import { createPrivilegedDatabase } from './db/supabase';

try {
  const client = createPrivilegedDatabase(readServerConfig(process.env));
  const result = await client.from('products').select('id').limit(1);
  if (result.error) throw new Error('unavailable');
  console.log('Healthy: Supabase credentials and foundation table are reachable.');
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message :
    'Unhealthy: Supabase could not be reached. Check credentials, migrations, and network access.');
  process.exitCode = 1;
}
