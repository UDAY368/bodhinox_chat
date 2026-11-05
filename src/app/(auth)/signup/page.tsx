import { currentTermsVersion } from '@/lib/auth/service';
import { SignupPageClient } from './signup-form';

// Read per request: TERMS_VERSION is a runtime setting (unset = no terms checkbox,
// exactly as before). Only the version string reaches the browser.
export const dynamic = 'force-dynamic';

export default function SignupPage() {
  return <SignupPageClient termsVersion={currentTermsVersion()} />;
}
