import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { parseConfig } from '../dist/config.js';
import { safeError } from '../dist/errors.js';
import { ConnectionTester } from '../dist/ui-test.js';

class RpcUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const tester = new ConnectionTester();
    this.onRequest('/validate', config => {
      try {
        if (config.platform !== 'Rpc3Control') return { valid: false, error: 'Invalid platform name.' };
        parseConfig(config.pdus);
        return { valid: true };
      } catch (error) { return { valid: false, error: safeError(error) }; }
    });
    this.onRequest('/test-connection', pdu => tester.test(pdu));
    process.once('disconnect', () => tester.stop());
    this.ready();
  }
}

new RpcUiServer();
