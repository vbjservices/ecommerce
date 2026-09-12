// Negative build fixture: this import MUST fail in a browser bundle.
import { readServerConfig } from '../../src/server/config';
console.log(readServerConfig({}));
