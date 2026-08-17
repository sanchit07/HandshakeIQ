import { describe, it } from 'node:test';
import assert from 'node:assert';
import { encryptSecret, decryptSecret, generateStrongPassword } from './credentialVault.js';
import {
  evaluateDomainControl, blockCooldownMs, DOWNGRADE_AFTER_BLOCKS, DOMAIN_RUN_COOLDOWN_MS,
} from './guardrails.js';
import { chooseApplyChannel } from './core.js';
import { preserveContinuation } from '../applyService.js';
import { classifyAuthPage, extractVerificationLink, isSafeVerificationLink, isAutoCheckableConsent } from './loginPages.js';

const SECRET = 'test-secret-for-vault-crypto';

describe('credential vault crypto', () => {
  it('round-trips a password', () => {
    const enc = encryptSecret('S0me!Portal-Pass', SECRET);
    assert.ok(!(enc).includes('S0me!Portal-Pass'));
    assert.strictEqual(decryptSecret(enc, SECRET), 'S0me!Portal-Pass');
  });

  it('uses a random IV — same plaintext encrypts differently', () => {
    assert.notStrictEqual(encryptSecret('same', SECRET), encryptSecret('same', SECRET));
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const enc = encryptSecret('secret-value', SECRET);
    const [iv, tag, ct] = enc.split('.');
    const bytes = Buffer.from(ct, 'base64');
    bytes[0] ^= 0xff;
    assert.throws(() => decryptSecret(`${iv}.${tag}.${bytes.toString('base64')}`, SECRET));
  });

  it('rejects the wrong key', () => {
    const enc = encryptSecret('secret-value', SECRET);
    assert.throws(() => decryptSecret(enc, 'a-different-secret'));
  });

  it('rejects malformed input', () => {
    assert.throws(() => decryptSecret('not-an-encrypted-blob', SECRET));
  });
});

describe('generated passwords', () => {
  it('meet complexity rules every time', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateStrongPassword();
      assert.ok(pw.length >= 16);
      assert.match(String(pw), /[A-Z]/);
      assert.match(String(pw), /[a-z]/);
      assert.match(String(pw), /[0-9]/);
      assert.match(String(pw), /[!@#$%^*\-_+=]/);
    }
  });

  it('are unique', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateStrongPassword()));
    assert.strictEqual(set.size, 100);
  });
});

describe('domain guard-rails', () => {
  const now = new Date('2026-08-17T12:00:00Z');

  it('allows unknown domains', () => {
    assert.strictEqual(evaluateDomainControl(null, now).allowed, true);
  });

  it('blocks downgraded domains with an assisted-mode explanation', () => {
    const r = evaluateDomainControl({ downgraded: true, cooldownUntil: null, lastRunAt: null }, now);
    assert.strictEqual(r.allowed, false);
    assert.match(String(r.reason), /assisted mode/i);
  });

  it('blocks during a cooldown window and allows after it', () => {
    const during = evaluateDomainControl({ downgraded: false, cooldownUntil: new Date(now.getTime() + 60_000), lastRunAt: null }, now);
    assert.strictEqual(during.allowed, false);
    assert.match(String(during.reason), /cooling down/i);
    const after = evaluateDomainControl({ downgraded: false, cooldownUntil: new Date(now.getTime() - 1000), lastRunAt: null }, now);
    assert.strictEqual(after.allowed, true);
  });

  it('enforces a minimum gap between runs to one domain', () => {
    const recent = evaluateDomainControl({ downgraded: false, cooldownUntil: null, lastRunAt: new Date(now.getTime() - 30_000) }, now);
    assert.strictEqual(recent.allowed, false);
    const old = evaluateDomainControl({ downgraded: false, cooldownUntil: null, lastRunAt: new Date(now.getTime() - DOMAIN_RUN_COOLDOWN_MS - 1000) }, now);
    assert.strictEqual(old.allowed, true);
  });

  it('escalates block cooldowns and caps at 24h', () => {
    assert.strictEqual(blockCooldownMs(1), 30 * 60 * 1000);
    assert.strictEqual(blockCooldownMs(2), 2 * 60 * 60 * 1000);
    assert.strictEqual(blockCooldownMs(10), 24 * 60 * 60 * 1000);
    assert.ok(DOWNGRADE_AFTER_BLOCKS >= 2);
  });
});

describe('login-walled page classification', () => {
  it('detects a sign-in page', () => {
    assert.strictEqual(classifyAuthPage({
      text: 'Sign in to your account. Email Address. Password. Forgot password?',
      hasPasswordField: true, hasConfirmPasswordField: false, buttons: ['sign in'],
    }), 'sign_in');
  });

  it('detects account creation (confirm-password heuristic)', () => {
    assert.strictEqual(classifyAuthPage({
      text: 'Create Account. Email Address. Password. Verify New Password.',
      hasPasswordField: true, hasConfirmPasswordField: true, buttons: ['create account'],
    }), 'create_account');
  });

  it('detects the verify-email interstitial', () => {
    assert.strictEqual(classifyAuthPage({
      text: 'Almost there! A verification email has been sent to you@example.com. Check your inbox.',
      hasPasswordField: false, hasConfirmPasswordField: false, buttons: [],
    }), 'verify_email');
  });

  it('detects a wizard step', () => {
    assert.strictEqual(classifyAuthPage({
      text: 'My Information. Step 1 of 5. First Name. Last Name.',
      hasPasswordField: false, hasConfirmPasswordField: false, buttons: ['save and continue'],
    }), 'wizard');
  });

  it('detects the review page', () => {
    assert.strictEqual(classifyAuthPage({
      text: 'Review your application before you submit. Review and submit your information.',
      hasPasswordField: false, hasConfirmPasswordField: false, buttons: ['submit'],
    }), 'review');
  });

  it('detects a confirmation page', () => {
    assert.strictEqual(classifyAuthPage({
      text: 'Thank you for applying! Your application was submitted successfully.',
      hasPasswordField: false, hasConfirmPasswordField: false, buttons: [],
    }), 'confirmation');
  });
});

describe('run-gap bypass for verification-link continuation', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const justRan = { downgraded: false, cooldownUntil: null, lastRunAt: new Date(now.getTime() - 30_000) };

  it('bypasses only the between-runs gap', () => {
    assert.strictEqual(evaluateDomainControl(justRan, now).allowed, false);
    assert.strictEqual(evaluateDomainControl(justRan, now, { ignoreRunGap: true }).allowed, true);
  });

  it('never bypasses block cooldowns or downgrades', () => {
    const blocked = { downgraded: false, cooldownUntil: new Date(now.getTime() + 60_000), lastRunAt: null };
    assert.strictEqual(evaluateDomainControl(blocked, now, { ignoreRunGap: true }).allowed, false);
    const down = { downgraded: true, cooldownUntil: null, lastRunAt: null };
    assert.strictEqual(evaluateDomainControl(down, now, { ignoreRunGap: true }).allowed, false);
  });
});

describe('signup consent checkbox safety', () => {
  it('allows only plain terms/privacy acknowledgements', () => {
    assert.strictEqual(isAutoCheckableConsent('I agree to the Terms of Use and Privacy Policy'), true);
    assert.strictEqual(isAutoCheckableConsent('I accept the terms and conditions'), true);
    assert.strictEqual(isAutoCheckableConsent('I have read the Privacy Statement'), true);
  });

  it('never checks marketing, outreach, or attestation boxes', () => {
    assert.strictEqual(isAutoCheckableConsent('Send me marketing emails and updates'), false);
    assert.strictEqual(isAutoCheckableConsent('I agree to the terms and to receive promotional offers'), false);
    assert.strictEqual(isAutoCheckableConsent('Join our talent community'), false);
    assert.strictEqual(isAutoCheckableConsent('I consent to a background check'), false);
    assert.strictEqual(isAutoCheckableConsent('I certify the above information is true'), false);
    assert.strictEqual(isAutoCheckableConsent('Text me about job alerts'), false);
    assert.strictEqual(isAutoCheckableConsent(''), false);
    assert.strictEqual(isAutoCheckableConsent('Remember me'), false);
  });
});

describe('apply channel routing order', () => {
  it('a recognized ATS route always beats an available contact email', () => {
    // Regression: login-walled ATSs must never fall through to email drafting
    assert.strictEqual(chooseApplyChannel('workday', true), 'ats_login_walled');
    assert.strictEqual(chooseApplyChannel('icims', true), 'ats_login_walled');
    assert.strictEqual(chooseApplyChannel('taleo', true), 'ats_login_walled');
    assert.strictEqual(chooseApplyChannel('successfactors', true), 'ats_login_walled');
    assert.strictEqual(chooseApplyChannel('greenhouse', true), 'ats_supported');
  });

  it('email is only used when no recognized ATS route exists', () => {
    assert.strictEqual(chooseApplyChannel(null, true), 'email');
    assert.strictEqual(chooseApplyChannel('someotherats', true), 'email');
    assert.strictEqual(chooseApplyChannel('someotherats', false), 'ats_generic');
    assert.strictEqual(chooseApplyChannel(null, false), 'assisted');
  });
});

describe('continuation state across packet rebuilds', () => {
  it('a pasted verification link survives the retry rebuild', () => {
    const prior = { answers: [], verificationLink: 'https://acme.wd3.myworkdayjobs.com/verify?token=abc' };
    const rebuilt = preserveContinuation(prior, { answers: [{ label: 'Name', value: 'X' }] });
    assert.strictEqual(rebuilt.verificationLink, 'https://acme.wd3.myworkdayjobs.com/verify?token=abc');
  });

  it('no-ops when there is no prior link', () => {
    assert.strictEqual(preserveContinuation(null, {}).verificationLink, undefined);
    assert.strictEqual(preserveContinuation({ verificationLink: '' }, {}).verificationLink, undefined);
  });
});

describe('verification links', () => {
  const portal = 'acme.wd3.myworkdayjobs.com';

  it('extracts the portal verification link from an email body', () => {
    const body = `Welcome!\nVisit https://tracking.example.com/open?id=1 first.\nVerify here: https://acme.wd3.myworkdayjobs.com/verify?token=abc123\nThanks`;
    assert.strictEqual(extractVerificationLink(body, portal), 'https://acme.wd3.myworkdayjobs.com/verify?token=abc123');
  });

  it('returns null when no plausible link exists', () => {
    assert.strictEqual(extractVerificationLink('No links here. https://unrelated.example.com/promo', portal), null);
  });

  it('only accepts links on the portal registrable domain', () => {
    assert.strictEqual(isSafeVerificationLink('https://acme.wd3.myworkdayjobs.com/verify?token=x', portal), true);
    assert.strictEqual(isSafeVerificationLink('https://login.myworkdayjobs.com/verify', portal), true);
    assert.strictEqual(isSafeVerificationLink('https://evil.example.com/verify', portal), false);
    assert.strictEqual(isSafeVerificationLink('javascript:alert(1)', portal), false);
    assert.strictEqual(isSafeVerificationLink('not a url', portal), false);
  });
});
