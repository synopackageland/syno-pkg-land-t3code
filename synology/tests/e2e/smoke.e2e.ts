import { appOpenSmoke } from '@synopackageland/cli/e2e';

// T3 Code's sidebar renders this after the gateway admitted the administrator
// and T3 Code accepted the gateway's session, so no pairing page was shown.
appOpenSmoke({ ready: { text: 'Add project' } });
