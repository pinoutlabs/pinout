#!/usr/bin/env node
/**
 * Entry for `npm run demo:awareness`.
 * Delegates to examples/awareness-connector-demo (SIMULATED).
 */
import { main } from '../../examples/awareness-connector-demo/src/runDemo.js';

await main();
