/**
 * T-10 / INV-10 compile-time half: the remote surface must not even type as a
 * write API. `tsc` (typecheck) is the executable assertion for this file.
 */
import * as remote from '../../src/remote/index.js'

// @ts-expect-error the remote surface has no write method by design
void remote.panelWrite
